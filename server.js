require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');

const GitHubClient = require('./github-client');
const { buildCollaboratorTable } = require('./lib/collaborators');
const { scan } = require('./lib/scanner');
const { normalize } = require('./lib/remote');
const git = require('./lib/git');
const { mapLimit } = require('./lib/concurrency');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4321;
const SCAN_ROOT = path.resolve(process.env.SCAN_ROOT || path.join(__dirname, '..'));
const SCAN_DEPTH = Number(process.env.SCAN_DEPTH) || 4;

const client = process.env.GITHUB_TOKEN ? new GitHubClient(process.env.GITHUB_TOKEN) : null;
git.setGithubToken(process.env.GITHUB_TOKEN);

const cache = {
  user: null,
  accountRepos: null,
  collaborators: null,
  collaboratorsLoading: null,
  scanned: null,
  reposById: new Map()
};

function requireClient() {
  if (!client) {
    const error = new Error('GITHUB_TOKEN is not set. Add it to .env to load your GitHub repositories.');
    error.status = 503;
    throw error;
  }
  return client;
}

async function getUser() {
  if (!cache.user) {
    cache.user = await requireClient().getUser();
  }
  return cache.user;
}

async function getAccountRepos(refresh = false) {
  if (!cache.accountRepos || refresh) {
    cache.accountRepos = await requireClient().getRepositories();
  }
  return cache.accountRepos;
}

function repoId(repoPath) {
  return crypto.createHash('sha1').update(repoPath).digest('hex').slice(0, 12);
}

async function rescan() {
  const scanned = await scan(SCAN_ROOT, { maxDepth: SCAN_DEPTH });
  cache.reposById = new Map();
  for (const repo of scanned) {
    repo.id = repoId(repo.path);
    const githubRemote = repo.remotes.origin && normalize(repo.remotes.origin)
      ? repo.remotes.origin
      : Object.values(repo.remotes).find(url => normalize(url));
    repo.remoteUrl = repo.remotes.origin || Object.values(repo.remotes)[0] || null;
    repo.fullName = githubRemote ? normalize(githubRemote) : null;
    cache.reposById.set(repo.id, repo);
  }
  cache.scanned = scanned;
  return scanned;
}

function getRepo(id) {
  const repo = cache.reposById.get(id);
  if (!repo) {
    const error = new Error('Unknown repository. Try rescanning.');
    error.status = 404;
    throw error;
  }
  return repo;
}

function summarizeStatus(status) {
  const changed = new Set(
    [status.staged, status.unstaged, status.untracked, status.conflicted].flat().map(f => f.path)
  );
  return {
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    changes: changed.size,
    conflicted: status.conflicted.length
  };
}

async function repoSummary(repo) {
  if (repo.error) return { error: repo.error };
  try {
    return summarizeStatus(await git.status(repo.path));
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Summaries for a repository and every checkout sharing its git directory.
 * A fetch in one worktree changes ahead/behind in the others too.
 */
async function summariesFor(repo) {
  const related = (cache.scanned || []).filter(r => r.commonDir === repo.commonDir);
  if (!related.includes(repo)) related.push(repo);
  const summaries = {};
  await mapLimit(related, 8, async r => {
    summaries[r.id] = await repoSummary(r);
  });
  return summaries;
}

function localView(repo, statusById) {
  return {
    id: repo.id,
    name: repo.name,
    path: repo.path,
    relPath: repo.relPath,
    remoteUrl: repo.remoteUrl,
    fullName: repo.fullName,
    isWorktree: repo.isWorktree,
    status: statusById.get(repo.id) || null,
    worktrees: []
  };
}

/**
 * Match scanned local repos to account repos and group worktrees under their main repo
 */
async function buildSyncView({ rescanDisk = false, refreshAccount = false } = {}) {
  if (!cache.scanned || rescanDisk) {
    await rescan();
  }
  const scanned = cache.scanned;

  let accountRepos = [];
  let accountError = null;
  try {
    accountRepos = await getAccountRepos(refreshAccount);
  } catch (error) {
    accountError = error.message;
  }

  const statusById = new Map();
  await mapLimit(scanned, 8, async repo => {
    statusById.set(repo.id, await repoSummary(repo));
  });

  // Group worktrees under the main checkout that shares their git directory
  const mainByCommonDir = new Map();
  for (const repo of scanned) {
    if (!repo.isWorktree && !repo.error) mainByCommonDir.set(repo.commonDir, repo);
  }
  const views = new Map(scanned.map(repo => [repo.id, localView(repo, statusById)]));
  const topLevel = [];
  for (const repo of scanned) {
    const main = repo.isWorktree ? mainByCommonDir.get(repo.commonDir) : null;
    if (main) {
      views.get(main.id).worktrees.push(views.get(repo.id));
    } else {
      topLevel.push(views.get(repo.id));
    }
  }

  const accountByName = new Map(accountRepos.map(r => [r.full_name.toLowerCase(), r]));
  const localsByName = new Map();
  const localOnly = [];
  for (const view of topLevel) {
    if (view.fullName && accountByName.has(view.fullName)) {
      if (!localsByName.has(view.fullName)) localsByName.set(view.fullName, []);
      localsByName.get(view.fullName).push(view);
    } else {
      localOnly.push(view);
    }
  }

  const matched = [];
  const notCloned = [];
  for (const repo of accountRepos) {
    const account = {
      fullName: repo.full_name,
      name: repo.name,
      owner: repo.owner.login,
      private: repo.private,
      url: repo.html_url,
      defaultBranch: repo.default_branch,
      pushedAt: repo.pushed_at
    };
    const locals = localsByName.get(repo.full_name.toLowerCase());
    if (locals) {
      matched.push({ ...account, locals });
    } else {
      notCloned.push(account);
    }
  }

  return { scanRoot: SCAN_ROOT, accountError, matched, notCloned, localOnly };
}

async function repoDetail(repo) {
  const [status, branches, log, stashes, lastMessage, operation] = await Promise.all([
    git.status(repo.path),
    git.branches(repo.path),
    git.log(repo.path),
    git.stashList(repo.path),
    git.lastCommitMessage(repo.path),
    git.operationInProgress(repo.path)
  ]);
  return {
    id: repo.id,
    name: repo.name,
    path: repo.path,
    relPath: repo.relPath,
    remoteUrl: repo.remoteUrl,
    fullName: repo.fullName,
    isWorktree: repo.isWorktree,
    status,
    branches,
    log,
    stashes,
    lastMessage,
    operation
  };
}

/**
 * Combine git's stdout and stderr for display, dropping terminal control sequences
 */
function formatOutput(result) {
  return [result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .trim();
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/**
 * Validate repository-relative paths: they must stay inside the repository
 */
function repoPaths(repo, files, { allowEmpty = false } = {}) {
  if (!Array.isArray(files) || (!allowEmpty && files.length === 0)) {
    throw badRequest('files must be a non-empty array of paths');
  }
  for (const file of files) {
    if (typeof file !== 'string' || !file || file.includes('\0')) {
      throw badRequest('Invalid file path');
    }
    const relative = path.relative(repo.path, path.resolve(repo.path, file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw badRequest(`Path is outside the repository: ${file}`);
    }
  }
  return files;
}

/**
 * Like repoPaths, but also resolves symlinks. Used where git reads the file directly from disk.
 */
async function realRepoPath(repo, file) {
  repoPaths(repo, [file]);
  const [root, real] = await Promise.all([
    fs.promises.realpath(repo.path),
    fs.promises.realpath(path.resolve(repo.path, file)).catch(() => null)
  ]);
  const relative = real && path.relative(root, real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw badRequest(`Path is outside the repository: ${file}`);
  }
  return file;
}

async function discard(repo, body) {
  let files;
  let untracked;
  if (body.all) {
    const status = await git.status(repo.path);
    files = status.unstaged.map(f => f.path);
    untracked = status.untracked.map(f => f.path);
  } else {
    files = repoPaths(repo, body.files || [], { allowEmpty: true });
    untracked = repoPaths(repo, body.untracked || [], { allowEmpty: true });
  }
  if (files.length === 0 && untracked.length === 0) {
    throw badRequest('Nothing to discard');
  }
  return git.discard(repo.path, files, untracked);
}

const actions = {
  fetch: (repo) => git.fetch(repo.path),
  pull: (repo, body) => git.pull(repo.path, String(body.mode || 'default')),
  push: (repo, body) => git.push(repo.path, { force: body.force === true }),
  stage: (repo, body) => git.stage(repo.path, body.all ? null : repoPaths(repo, body.files)),
  unstage: (repo, body) => git.unstage(repo.path, body.all ? null : repoPaths(repo, body.files)),
  discard,
  commit: (repo, body) => git.commit(repo.path, String(body.message || ''), { amend: body.amend === true }),
  checkout: (repo, body) => body.remoteBranch
    ? git.checkoutRemote(repo.path, String(body.remoteBranch))
    : git.checkout(repo.path, String(body.branch || '')),
  branch: (repo, body) => git.createBranch(repo.path, String(body.name || '')),
  stash: (repo, body) => git.stashPush(repo.path, String(body.message || '')),
  'stash-apply': (repo, body) => git.stashApply(repo.path, String(body.ref || '')),
  'stash-pop': (repo, body) => git.stashApply(repo.path, String(body.ref || ''), { pop: true }),
  'stash-drop': (repo, body) => git.stashDrop(repo.path, String(body.ref || '')),
  abort: (repo) => git.resolveOperation(repo.path, 'abort'),
  continue: (repo) => git.resolveOperation(repo.path, 'continue')
};

/**
 * Fetch every scanned git directory once (worktrees share objects with their main repo)
 */
async function fetchAll() {
  if (!cache.scanned) await rescan();
  const seen = new Set();
  const targets = cache.scanned.filter(repo => {
    if (repo.error || seen.has(repo.commonDir)) return false;
    seen.add(repo.commonDir);
    return Object.keys(repo.remotes).length > 0;
  });
  return mapLimit(targets, 4, async repo => {
    try {
      await git.fetch(repo.path);
      return { id: repo.id, relPath: repo.relPath, ok: true };
    } catch (error) {
      return { id: repo.id, relPath: repo.relPath, ok: false, error: error.message };
    }
  });
}

async function loadCollaborators(refresh) {
  const user = await getUser();
  const repos = await getAccountRepos(refresh);
  const result = await buildCollaboratorTable(client, repos, user.login);
  // Don't keep an incomplete table around: the next request retries the failed repos
  cache.collaborators = result.failed.length === 0 ? result : null;
  return result;
}

const app = express();
const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);

// Reject requests with a foreign Host header (DNS rebinding). API calls must carry a custom
// header (which cross-site pages can't send without CORS), and writes must come from this origin.
app.use((req, res, next) => {
  if (!allowedHosts.has(req.headers.host)) {
    return res.status(403).json({ error: 'Forbidden host' });
  }
  if (req.path.startsWith('/api/')) {
    if (req.headers['x-requested-with'] !== 'repo-collaborators') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (!origin || !allowedHosts.has(origin.replace(/^http:\/\//, ''))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/me', async (req, res) => {
  const user = await getUser();
  res.json({ login: user.login, avatarUrl: user.avatar_url, url: user.html_url, scanRoot: SCAN_ROOT });
});

app.get('/api/collaborators', async (req, res) => {
  const refresh = req.query.refresh === '1';
  if (cache.collaborators && !refresh) {
    return res.json(cache.collaborators);
  }
  // Share one in-flight load between concurrent requests
  if (!cache.collaboratorsLoading) {
    cache.collaboratorsLoading = loadCollaborators(refresh).finally(() => {
      cache.collaboratorsLoading = null;
    });
  }
  res.json(await cache.collaboratorsLoading);
});

app.get('/api/sync', async (req, res) => {
  res.json(await buildSyncView({
    rescanDisk: req.query.rescan === '1',
    refreshAccount: req.query.refresh === '1'
  }));
});

app.post('/api/sync/fetch-all', async (req, res) => {
  res.json({ results: await fetchAll() });
});

/**
 * Fetch everything, then fast-forward every checkout that is behind its upstream,
 * has no local commits and no uncommitted changes. Anything else is reported as skipped.
 */
app.post('/api/sync/pull-all', async (req, res) => {
  const fetched = await fetchAll();
  const fetchFailed = fetched.filter(r => !r.ok);
  const failedDirs = new Set(fetchFailed.map(r => getRepo(r.id).commonDir));

  const pulled = [];
  const skipped = [];
  const failed = fetchFailed.map(r => ({ relPath: r.relPath, error: `fetch: ${r.error}` }));

  await mapLimit(cache.scanned.filter(r => !r.error && !failedDirs.has(r.commonDir)), 4, async repo => {
    const summary = await repoSummary(repo);
    if (summary.error || !summary.upstream || summary.behind === 0) return;
    if (summary.ahead > 0) {
      skipped.push({ relPath: repo.relPath, reason: `diverged (↑${summary.ahead} ↓${summary.behind})` });
    } else if (summary.changes > 0) {
      skipped.push({ relPath: repo.relPath, reason: 'uncommitted changes' });
    } else {
      try {
        await git.pull(repo.path, 'ff-only');
        pulled.push({ relPath: repo.relPath, commits: summary.behind });
      } catch (error) {
        failed.push({ relPath: repo.relPath, error: error.message });
      }
    }
  });

  res.json({ pulled, skipped, failed });
});

app.get('/api/repo/status', async (req, res) => {
  res.json(await repoDetail(getRepo(req.query.id)));
});

app.get('/api/repo/diff', async (req, res) => {
  const repo = getRepo(req.query.id);
  const file = String(req.query.file || '');
  if (!file) return res.status(400).json({ error: 'file is required' });
  const untracked = req.query.untracked === '1';
  // An untracked diff reads the file straight from disk, so also check where symlinks point
  if (untracked) await realRepoPath(repo, file);
  else repoPaths(repo, [file]);
  const diff = await git.diff(repo.path, file, { staged: req.query.staged === '1', untracked });
  res.json({ diff });
});

app.post('/api/repo/:action', async (req, res) => {
  const action = actions[req.params.action];
  if (!action) return res.status(404).json({ error: 'Unknown action' });
  const body = req.body || {};
  const repo = getRepo(body.id);
  let result;
  try {
    result = await action(repo, body);
  } catch (error) {
    // A failed pull or checkout can still change the repo (e.g. conflicts), so send fresh state
    [error.detail, error.summaries] = await Promise.all([
      repoDetail(repo).catch(() => null),
      summariesFor(repo)
    ]);
    throw error;
  }
  const [detail, summaries] = await Promise.all([repoDetail(repo), summariesFor(repo)]);
  res.json({
    output: formatOutput(result),
    detail,
    summaries
  });
});

app.post('/api/clone', async (req, res) => {
  const fullName = String(req.body?.fullName || '').toLowerCase();
  const repos = await getAccountRepos();
  const repo = repos.find(r => r.full_name.toLowerCase() === fullName);
  if (!repo) return res.status(404).json({ error: 'Repository is not in your account' });

  const dest = path.join(SCAN_ROOT, repo.name);
  if (fs.existsSync(dest)) {
    return res.status(409).json({ error: `${dest} already exists` });
  }
  const result = await git.clone(SCAN_ROOT, repo.clone_url, repo.name);
  await rescan();
  res.json({ output: formatOutput(result), path: dest });
});

app.use((err, req, res, next) => {
  const status = err.status || (err instanceof git.GitError ? 400 : err.response?.status || 500);
  res.status(status).json({
    error: err.message,
    stdout: err.stdout || undefined,
    stderr: err.stderr || undefined,
    detail: err.detail || undefined,
    summaries: err.summaries || undefined
  });
});

function openBrowser(url) {
  const command = { darwin: 'open', win32: 'explorer' }[process.platform] || 'xdg-open';
  execFile(command, [url], () => {});
}

if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Repo Collaborators UI running at ${url}`);
    console.log(`Scanning for local repositories under ${SCAN_ROOT} (depth ${SCAN_DEPTH})`);
    if (!client) {
      console.warn('GITHUB_TOKEN is not set - only local repositories will be shown.');
    }
    if (process.env.NO_OPEN !== '1') openBrowser(url);
  });
  // Fetch-all and clone can outlast Node's default 5 minute request timeout
  server.requestTimeout = 0;
}

module.exports = app;
