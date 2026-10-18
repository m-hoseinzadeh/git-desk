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
  accountLoading: null,
  collabRun: null,
  scanned: null,
  scanning: null,
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
  if (cache.accountRepos && !refresh) return cache.accountRepos;
  // Share one in-flight load between concurrent requests
  if (!cache.accountLoading) {
    cache.accountLoading = requireClient().getRepositories()
      .then(repos => (cache.accountRepos = repos))
      .finally(() => { cache.accountLoading = null; });
  }
  return cache.accountLoading;
}

function repoId(repoPath) {
  return crypto.createHash('sha1').update(repoPath).digest('hex').slice(0, 12);
}

function rescan() {
  if (!cache.scanning) {
    cache.scanning = doRescan().finally(() => { cache.scanning = null; });
  }
  return cache.scanning;
}

async function doRescan() {
  const scanned = await scan(SCAN_ROOT, { maxDepth: SCAN_DEPTH });
  cache.reposById = new Map();
  for (const repo of scanned) {
    repo.id = repoId(repo.path);
    applyRemotes(repo, repo.remotes);
    cache.reposById.set(repo.id, repo);
  }
  cache.scanned = scanned;
  return scanned;
}

/**
 * Set a scanned repository's remotes and what is derived from them: the URL shown for it
 * and the GitHub repository it is matched to (origin first, else the first GitHub remote)
 */
function applyRemotes(repo, remotes) {
  repo.remotes = remotes;
  const githubRemote = remotes.origin && normalize(remotes.origin)
    ? remotes.origin
    : Object.values(remotes).find(url => normalize(url));
  repo.remoteUrl = remotes.origin || Object.values(remotes)[0] || null;
  repo.fullName = githubRemote ? normalize(githubRemote) : null;
}

/**
 * Re-read remotes after they changed. Remotes live in the shared config, so every
 * checkout of the same git directory gets the new list.
 */
async function reloadRemotes(repo) {
  const remotes = await git.remotes(repo.path);
  for (const r of cache.scanned || []) {
    if (r.commonDir === repo.commonDir && !r.error) applyRemotes(r, { ...remotes });
  }
  if (!(cache.scanned || []).includes(repo)) applyRemotes(repo, remotes);
}

const repoLocks = new Map(); // commonDir -> promise that settles when the queued work is done

/**
 * Run git work on a repository once the work queued before it has finished. Two git commands
 * at once fail on index.lock or ref locks, and checkouts sharing a git directory share refs,
 * so they queue together.
 */
function withRepoLock(repo, fn) {
  const key = repo.commonDir;
  const work = (repoLocks.get(key) || Promise.resolve()).then(fn);
  const tail = work.catch(() => {});
  repoLocks.set(key, tail);
  tail.then(() => {
    if (repoLocks.get(key) === tail) repoLocks.delete(key);
  });
  return work;
}

/**
 * Look up a repository by scan id. An unknown id rescans once first: after a server restart
 * the cache is empty while the page still lists repositories, and a repository may have
 * appeared since the last scan.
 */
async function getRepo(id) {
  let repo = cache.reposById.get(id);
  if (!repo && id) {
    await rescan();
    repo = cache.reposById.get(id);
  }
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

function localView(repo) {
  return {
    id: repo.id,
    name: repo.name,
    path: repo.path,
    relPath: repo.relPath,
    remoteUrl: repo.remoteUrl,
    fullName: repo.fullName,
    isWorktree: repo.isWorktree,
    status: null,
    worktrees: []
  };
}

/**
 * Local repositories, with worktrees nested under the main checkout that shares their git directory
 */
function localTree(scanned) {
  const mainByCommonDir = new Map();
  for (const repo of scanned) {
    if (!repo.isWorktree && !repo.error) mainByCommonDir.set(repo.commonDir, repo);
  }
  const views = new Map(scanned.map(repo => [repo.id, localView(repo)]));
  const topLevel = [];
  for (const repo of scanned) {
    const main = repo.isWorktree ? mainByCommonDir.get(repo.commonDir) : null;
    if (main) {
      views.get(main.id).worktrees.push(views.get(repo.id));
    } else {
      topLevel.push(views.get(repo.id));
    }
  }
  return topLevel;
}

function accountView(repo) {
  return {
    fullName: repo.full_name,
    name: repo.name,
    owner: repo.owner.login,
    private: repo.private,
    url: repo.html_url,
    defaultBranch: repo.default_branch,
    pushedAt: repo.pushed_at
  };
}

async function repoDetail(repo) {
  const [status, branches, log, stashes, lastMessage, operation, remotes] = await Promise.all([
    git.status(repo.path),
    git.branches(repo.path),
    git.log(repo.path),
    git.stashList(repo.path),
    git.lastCommitMessage(repo.path),
    git.operationInProgress(repo.path),
    git.remoteList(repo.path)
  ]);
  const remoteTracking = await git.remoteTracking(repo.path, status, remotes.map(r => r.name));
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
    operation,
    remotes,
    remoteTracking
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

function optionalString(value) {
  return value === undefined || value === null ? null : String(value);
}

const actions = {
  fetch: (repo, body) => git.fetch(repo.path, optionalString(body.remote)),
  pull: (repo, body) => git.pull(repo.path, String(body.mode || 'default'), optionalString(body.remote)),
  push: (repo, body) => git.push(repo.path, { force: body.force === true, remote: optionalString(body.remote) }),
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
  continue: (repo) => git.resolveOperation(repo.path, 'continue'),
  'remote-add': (repo, body) => git.addRemote(repo.path, String(body.name || ''), String(body.url || '').trim()),
  'remote-rename': (repo, body) => git.renameRemote(repo.path, String(body.name || ''), String(body.newName || '')),
  'remote-set-url': (repo, body) => git.setRemoteUrl(repo.path, String(body.name || ''), String(body.url || '').trim(), {
    push: body.push === true
  }),
  'remote-remove': (repo, body) => git.removeRemote(repo.path, String(body.name || ''))
};

/**
 * Fresh state to send after an action. Remote changes also change how repositories are
 * matched to GitHub, so those send the local repository list too.
 */
async function actionState(repo, actionName) {
  let locals;
  if (actionName.startsWith('remote-')) {
    await reloadRemotes(repo).catch(() => {});
    locals = localTree(cache.scanned || []);
  }
  const [detail, summaries] = await Promise.all([repoDetail(repo).catch(() => null), summariesFor(repo)]);
  return { detail, summaries, locals };
}

/**
 * Scanned checkouts grouped by git directory. Worktrees share objects and refs with
 * their main repo, so one fetch covers the whole group.
 */
function remoteGroups() {
  const groups = new Map();
  for (const repo of cache.scanned) {
    if (repo.error || Object.keys(repo.remotes).length === 0) continue;
    if (!groups.has(repo.commonDir)) groups.set(repo.commonDir, []);
    groups.get(repo.commonDir).push(repo);
  }
  return [...groups.values()].map(group => ({
    target: group.find(repo => !repo.isWorktree) || group[0],
    checkouts: group
  }));
}

async function fetchGroup(group, stream) {
  stream.send({ type: 'begin', id: group.target.id });
  try {
    await withRepoLock(group.target, () => git.fetch(group.target.path));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Fast-forward a checkout that is behind its upstream and has no local commits or changes
 * to tracked files. Runs after its git directory was fetched, so it merges without fetching again.
 * @returns {Promise<Object>} { kind: 'pulled' | 'current' | 'skipped' | 'failed', relPath, ... }
 */
async function pullIfClean(repo) {
  const relPath = repo.relPath;
  let st;
  try {
    st = await git.status(repo.path);
  } catch (error) {
    return { kind: 'failed', relPath, error: error.message };
  }
  if (!st.branch) return { kind: 'skipped', relPath, reason: 'detached HEAD' };
  if (!st.upstream) return { kind: 'skipped', relPath, reason: `${st.branch} has no upstream branch` };
  if (st.behind === 0) return { kind: 'current', relPath };
  if (st.ahead > 0) {
    return { kind: 'skipped', relPath, reason: `diverged (↑${st.ahead} ↓${st.behind}), pull it with rebase or merge` };
  }
  // Untracked files don't block a fast-forward; git refuses by itself if one would be overwritten
  const changed = new Set([st.staged, st.unstaged, st.conflicted].flat().map(f => f.path)).size;
  if (changed > 0) {
    return { kind: 'skipped', relPath, reason: `${changed} uncommitted change${changed === 1 ? '' : 's'}` };
  }
  try {
    await git.fastForward(repo.path);
    return { kind: 'pulled', relPath, commits: st.behind };
  } catch (error) {
    return { kind: 'failed', relPath, error: error.message };
  }
}

/**
 * Collaborator loads run once and are shared: a later request (another tab, a page reload)
 * replays the events so far and then follows along. A finished run without failures is the cache.
 */
function collaboratorRun(refresh) {
  const current = cache.collabRun;
  if (current && (!current.finished || (!refresh && current.complete))) return current;

  const run = { events: [], listeners: new Set(), finished: false, complete: false };
  const emit = event => {
    run.events.push(event);
    run.listeners.forEach(listener => listener(event));
  };
  cache.collabRun = run;

  (async () => {
    try {
      const user = await getUser();
      const repos = await getAccountRepos(refresh);
      emit({ type: 'start', total: repos.length });
      const { failed } = await buildCollaboratorTable(client, repos, user.login, {
        concurrency: 6,
        onResult: ({ index, repo, row, failed: didFail }) => {
          emit({ type: 'result', index, row, failed: didFail ? repo.full_name : null });
        }
      });
      run.complete = failed.length === 0;
    } catch (error) {
      emit({ type: 'error', error: error.message });
    }
    run.finished = true;
    emit({ type: 'done' });
  })();

  return run;
}

/**
 * Stream newline-delimited JSON events while the work runs, so the UI can show
 * each result as soon as it is ready instead of waiting for the slowest one.
 */
function streamRoute(handler) {
  return async (req, res) => {
    let closed = false;
    const closeListeners = [];
    res.on('close', () => {
      closed = true;
      closeListeners.forEach(fn => fn());
    });
    res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    res.flushHeaders();

    const stream = {
      get closed() { return closed; },
      onClose(fn) { closeListeners.push(fn); },
      send(event) {
        if (!closed) res.write(`${JSON.stringify(event)}\n`);
      }
    };
    try {
      await handler(req, stream);
    } catch (error) {
      stream.send({ type: 'error', error: error.message });
    }
    res.end();
  };
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

app.get('/api/collaborators', streamRoute(async (req, stream) => {
  const run = collaboratorRun(req.query.refresh === '1');
  run.events.forEach(event => stream.send(event));
  if (run.finished) return;
  await new Promise(resolve => {
    const listener = event => {
      stream.send(event);
      if (event.type === 'done') stop();
    };
    const stop = () => {
      run.listeners.delete(listener);
      resolve();
    };
    run.listeners.add(listener);
    stream.onClose(stop);
  });
}));

/**
 * Sync view as a stream: the account repos (as soon as GitHub answers), the local
 * repositories (cached first, then after the disk scan), then one status per repository.
 * The client matches local clones to account repos.
 */
app.get('/api/sync', streamRoute(async (req, stream) => {
  const accountSent = getAccountRepos(req.query.refresh === '1').then(
    repos => stream.send({ type: 'account', repos: repos.map(accountView) }),
    error => stream.send({ type: 'account', error: error.message })
  );

  // Show the last scan right away; a rescan sends the list again (the client ignores it if unchanged)
  const sendLocals = () => stream.send({ type: 'locals', scanRoot: SCAN_ROOT, locals: localTree(cache.scanned) });
  if (cache.scanned) sendLocals();
  if (!cache.scanned || req.query.rescan === '1') {
    await rescan();
    sendLocals();
  }
  const scanned = cache.scanned;

  await mapLimit(scanned, 8, async repo => {
    if (stream.closed) return;
    stream.send({ type: 'status', id: repo.id, status: await repoSummary(repo) });
  });
  await accountSent;
  stream.send({ type: 'done' });
}));

app.post('/api/sync/fetch-all', streamRoute(async (req, stream) => {
  if (!cache.scanned) await rescan();
  const groups = remoteGroups();
  stream.send({ type: 'start', total: groups.length });
  await mapLimit(groups, 4, async group => {
    if (stream.closed) return;
    const result = await fetchGroup(group, stream);
    stream.send({
      type: 'fetched',
      id: group.target.id,
      relPath: group.target.relPath,
      ...result,
      summaries: await summariesFor(group.target)
    });
  });
  stream.send({ type: 'done' });
}));

/**
 * Fetch each git directory, then fast-forward its checkouts that are behind their upstream
 * and have no local commits or changes to tracked files. Every checkout gets a result, so
 * the ones that couldn't be pulled say why.
 */
app.post('/api/sync/pull-all', streamRoute(async (req, stream) => {
  if (!cache.scanned) await rescan();
  const groups = remoteGroups();
  stream.send({ type: 'start', total: groups.length });
  await mapLimit(groups, 4, async group => {
    if (stream.closed) return;
    const fetched = await fetchGroup(group, stream);
    const results = [];
    if (!fetched.ok) {
      results.push({ kind: 'failed', relPath: group.target.relPath, error: `fetch: ${fetched.error}` });
    } else {
      // One checkout at a time: worktrees of a group share refs and lock files
      await withRepoLock(group.target, async () => {
        for (const repo of group.checkouts) {
          results.push(await pullIfClean(repo));
        }
      });
    }
    stream.send({ type: 'group', id: group.target.id, results, summaries: await summariesFor(group.target) });
  });
  stream.send({ type: 'done' });
}));

app.get('/api/repo/status', async (req, res) => {
  res.json(await repoDetail(await getRepo(req.query.id)));
});

app.get('/api/repo/diff', async (req, res) => {
  const repo = await getRepo(req.query.id);
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
  const repo = await getRepo(body.id);
  let result;
  try {
    result = await withRepoLock(repo, () => action(repo, body));
  } catch (error) {
    // A failed pull or checkout can still change the repo (e.g. conflicts), so send fresh state
    Object.assign(error, await actionState(repo, req.params.action));
    throw error;
  }
  res.json({
    output: formatOutput(result),
    ...(await actionState(repo, req.params.action))
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
    hint: err.hint || undefined,
    reason: err.reason || undefined,
    detail: err.detail || undefined,
    summaries: err.summaries || undefined,
    locals: err.locals || undefined
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
    // Under `node --watch` (npm run dev) every restart would open another tab
    const watchMode = process.env.WATCH_REPORT_DEPENDENCIES === '1';
    if (process.env.NO_OPEN !== '1' && !watchMode) openBrowser(url);
  });
  // Fetch-all and clone can outlast Node's default 5 minute request timeout
  server.requestTimeout = 0;
}

module.exports = app;
