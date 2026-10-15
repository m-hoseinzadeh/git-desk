const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const NETWORK_TIMEOUT = 3 * 60 * 1000;
const LOCAL_TIMEOUT = 30 * 1000;

class GitError extends Error {
  constructor(message, { stdout = '', stderr = '', code = null } = {}) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
  }
}

let githubToken = null;

/**
 * Use this token for https://github.com when no other credential helper has one
 * @param {string|null} token - GitHub personal access token
 */
function setGithubToken(token) {
  githubToken = token || null;
}

// Credential helper that answers with the token from the environment, so the token never appears in argv
const TOKEN_HELPER = '!f() { test "$1" = get && echo username=x-access-token && echo "password=$REPO_COLLAB_GITHUB_TOKEN"; }; f';

/**
 * Run a git command without a shell. Credential prompts are disabled so
 * network commands fail fast instead of hanging the server.
 * @param {string} cwd - Working directory
 * @param {string[]} args - git arguments
 * @param {Object} options - { timeout, okCodes, env }
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function run(cwd, args, { timeout = LOCAL_TIMEOUT, okCodes = [0], env: extraEnv = {} } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...extraEnv };

  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      if (okCodes.includes(code)) {
        resolve({ stdout, stderr, code });
        return;
      }
      const message = (stderr || stdout || error.message).trim();
      reject(new GitError(message, { stdout, stderr, code }));
    });
  });
}

/**
 * Environment for commands that talk to a remote: fail fast on SSH, abort stalled
 * HTTPS transfers, and fall back to the GitHub token for HTTPS auth.
 */
async function networkEnv(cwd) {
  const env = {};
  const config = [
    // Abort HTTPS transfers that stall instead of waiting for the overall timeout
    ['http.lowSpeedLimit', '1000'],
    ['http.lowSpeedTime', '30']
  ];

  // GIT_SSH_COMMAND overrides core.sshCommand, so only set it when the user hasn't configured one
  if (!process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH) {
    const configured = await run(cwd, ['config', '--get', 'core.sshCommand'], { okCodes: [0, 1] });
    if (!configured.stdout.trim()) {
      env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=15';
    }
  }

  // Helpers from the user's config run first; this one is only asked if they have nothing
  if (githubToken) {
    config.push(['credential.https://github.com.helper', TOKEN_HELPER]);
    env.REPO_COLLAB_GITHUB_TOKEN = githubToken;
  }

  const base = Number(process.env.GIT_CONFIG_COUNT) || 0;
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${base + i}`] = key;
    env[`GIT_CONFIG_VALUE_${base + i}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(base + config.length);
  return env;
}

async function runNetwork(cwd, args) {
  return run(cwd, args, { timeout: NETWORK_TIMEOUT, env: await networkEnv(cwd) });
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output
 */
function parseStatus(output) {
  const result = {
    branch: null,
    oid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: []
  };

  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;

    if (entry.startsWith('# ')) {
      const [key, ...rest] = entry.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.head') result.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.oid') result.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.upstream') result.upstream = value;
      else if (key === 'branch.ab') {
        const m = value.match(/^\+(\d+) -(\d+)$/);
        if (m) {
          result.ahead = Number(m[1]);
          result.behind = Number(m[2]);
        }
      }
      continue;
    }

    const type = entry[0];
    if (type === '?') {
      result.untracked.push({ path: entry.slice(2), status: '?' });
      continue;
    }
    if (type === '!') continue;

    // Number of space-separated fields before the path, per entry type
    const fieldCount = { '1': 8, '2': 9, 'u': 10 }[type];
    if (!fieldCount) continue;

    const parts = entry.split(' ');
    const xy = parts[1];
    const filePath = parts.slice(fieldCount).join(' ');
    let origPath = null;
    if (type === '2') {
      origPath = tokens[++i];
    }

    if (type === 'u') {
      result.conflicted.push({ path: filePath, status: xy });
      continue;
    }

    const [x, y] = xy;
    if (x !== '.') result.staged.push({ path: filePath, status: x, origPath });
    if (y !== '.') result.unstaged.push({ path: filePath, status: y });
  }

  return result;
}

async function status(cwd) {
  const { stdout } = await run(cwd, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
  return parseStatus(stdout);
}

/**
 * @returns {Promise<Array<{name: string, fetchUrl: string|null, pushUrl: string|null}>>}
 */
async function remoteList(cwd) {
  const { stdout } = await run(cwd, ['remote', '-v']);
  const byName = new Map();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(\S+)\s+(.*?)\s+\((fetch|push)\)$/);
    if (!m) continue;
    if (!byName.has(m[1])) byName.set(m[1], { name: m[1], fetchUrl: null, pushUrl: null });
    const remote = byName.get(m[1]);
    // `remote -v` lists every push URL; keep the first, which is where a plain push goes
    if (m[3] === 'fetch') remote.fetchUrl = m[2];
    else if (!remote.pushUrl) remote.pushUrl = m[2];
  }
  return [...byName.values()];
}

/**
 * @returns {Promise<Object>} Remote name -> fetch URL
 */
async function remotes(cwd) {
  const list = await remoteList(cwd);
  return Object.fromEntries(list.filter(r => r.fetchUrl).map(r => [r.name, r.fetchUrl]));
}

// Git accepts names and URLs starting with "-", but other commands would read them as options
function validateRemoteName(name) {
  if (!name || name.startsWith('-') || /[\s\0]/.test(name)) {
    throw new GitError(`Invalid remote name: ${name}`);
  }
}

function validateRemoteUrl(url) {
  if (!url || url.startsWith('-') || /[\x00-\x1f\x7f]/.test(url)) {
    throw new GitError(`Invalid remote URL: ${url}`);
  }
}

async function requireRemote(cwd, name) {
  validateRemoteName(name);
  const list = await remoteList(cwd);
  if (!list.some(r => r.name === name)) {
    throw new GitError(`No such remote: ${name}`);
  }
}

async function addRemote(cwd, name, url) {
  validateRemoteName(name);
  validateRemoteUrl(url);
  return run(cwd, ['remote', 'add', '--', name, url]);
}

async function renameRemote(cwd, name, newName) {
  await requireRemote(cwd, name);
  validateRemoteName(newName);
  return run(cwd, ['remote', 'rename', '--', name, newName]);
}

/**
 * @param {Object} options - { push }: set the push URL instead; an empty URL drops the
 *   separate push URL so pushes go to the fetch URL again
 */
async function setRemoteUrl(cwd, name, url, { push = false } = {}) {
  await requireRemote(cwd, name);
  if (push && !url) {
    // Exit code 5: no push URL was set, which is the state we want
    return run(cwd, ['config', '--unset-all', `remote.${name}.pushurl`], { okCodes: [0, 5] });
  }
  validateRemoteUrl(url);
  return run(cwd, ['remote', 'set-url', ...(push ? ['--push'] : []), '--', name, url]);
}

async function removeRemote(cwd, name) {
  await requireRemote(cwd, name);
  return run(cwd, ['remote', 'remove', '--', name]);
}

async function commonDir(cwd) {
  const { stdout } = await run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return stdout.trim();
}

/**
 * @param {string} cwd - Repository path
 * @param {string|null} remote - Fetch only this remote; all remotes when null
 */
async function fetch(cwd, remote = null) {
  if (remote === null) {
    return runNetwork(cwd, ['fetch', '--all', '--prune']);
  }
  await requireRemote(cwd, remote);
  return runNetwork(cwd, ['fetch', '--prune', '--', remote]);
}

const PULL_MODES = {
  default: [],
  'ff-only': ['--ff-only'],
  rebase: ['--rebase'],
  merge: ['--no-rebase']
};

/**
 * @param {string} cwd - Repository path
 * @param {string} mode - 'default' (git config), 'ff-only', 'rebase' or 'merge'
 */
async function pull(cwd, mode = 'default') {
  const flags = PULL_MODES[mode];
  if (!flags) {
    throw new GitError(`Unknown pull mode: ${mode}`);
  }
  try {
    return await runNetwork(cwd, ['pull', ...flags]);
  } catch (error) {
    if (/divergent branches|Not possible to fast-forward/i.test(error.message)) {
      error.message += '\n\nHint: your branch and its upstream have diverged. Choose "rebase" or "merge" as the pull mode.';
    }
    throw error;
  }
}

/**
 * Push the current branch, setting its upstream on first push.
 * @param {string} cwd - Repository path
 * @param {Object} options - { force }: use --force-with-lease (e.g. after amending a pushed commit)
 */
async function push(cwd, { force = false } = {}) {
  const st = await status(cwd);
  if (!st.branch) {
    throw new GitError('Cannot push from a detached HEAD');
  }
  if (st.upstream) {
    const args = force ? ['push', '--force-with-lease'] : ['push'];
    try {
      return await runNetwork(cwd, args);
    } catch (error) {
      if (!force && /\[rejected\]|non-fast-forward|fetch first/i.test(error.message)) {
        error.message += '\n\nHint: the remote has commits you don\'t have. Pull first, or use "Force push" if you amended or rebased commits that were already pushed.';
      }
      throw error;
    }
  }
  const remoteMap = await remotes(cwd);
  const remote = remoteMap.origin ? 'origin' : Object.keys(remoteMap)[0];
  if (!remote) {
    throw new GitError('No remote configured');
  }
  return runNetwork(cwd, ['push', '-u', remote, st.branch]);
}

async function stage(cwd, files) {
  if (!files || files.length === 0) {
    return run(cwd, ['add', '-A']);
  }
  return run(cwd, ['add', '-A', '--', ...files]);
}

async function hasHead(cwd) {
  try {
    await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

async function unstage(cwd, files) {
  const targets = files && files.length > 0 ? files : ['.'];
  if (!(await hasHead(cwd))) {
    // No commits yet: `restore --staged` needs HEAD, so drop entries from the index instead
    return run(cwd, ['rm', '-r', '--cached', '--quiet', '--', ...targets]);
  }
  return run(cwd, ['restore', '--staged', '--', ...targets]);
}

/**
 * Throw away working-tree changes. Tracked files are restored from the index,
 * untracked files are deleted.
 */
async function discard(cwd, files, untrackedFiles) {
  const results = [];
  if (files.length > 0) {
    results.push(await run(cwd, ['restore', '--worktree', '--', ...files]));
  }
  if (untrackedFiles.length > 0) {
    results.push(await run(cwd, ['clean', '-f', '--', ...untrackedFiles]));
  }
  return {
    stdout: results.map(r => r.stdout).join(''),
    stderr: results.map(r => r.stderr).join('')
  };
}

async function commit(cwd, message, { amend = false } = {}) {
  if (!message || !message.trim()) {
    throw new GitError('Commit message is required');
  }
  const args = ['commit', '-m', message];
  if (amend) args.push('--amend');
  return run(cwd, args);
}

async function lastCommitMessage(cwd) {
  try {
    const { stdout } = await run(cwd, ['log', '-1', '--format=%B']);
    return stdout.trim();
  } catch {
    return null; // No commits yet
  }
}

// Markers git leaves in the git directory while an operation waits for conflict resolution
const OPERATION_MARKERS = [
  ['rebase', 'rebase-merge'],
  ['rebase', 'rebase-apply'],
  ['merge', 'MERGE_HEAD'],
  ['cherry-pick', 'CHERRY_PICK_HEAD'],
  ['revert', 'REVERT_HEAD']
];

/**
 * @returns {Promise<string|null>} 'rebase', 'merge', 'cherry-pick', 'revert' or null
 */
async function operationInProgress(cwd) {
  const args = ['rev-parse', ...OPERATION_MARKERS.flatMap(([, marker]) => ['--git-path', marker])];
  const { stdout } = await run(cwd, args);
  const paths = stdout.split('\n').filter(Boolean);
  const index = paths.findIndex(p => fs.existsSync(path.resolve(cwd, p)));
  return index === -1 ? null : OPERATION_MARKERS[index][0];
}

/**
 * Abort or continue the merge/rebase/cherry-pick/revert in progress
 * @param {string} cwd - Repository path
 * @param {string} step - 'abort' or 'continue'
 */
async function resolveOperation(cwd, step) {
  if (step !== 'abort' && step !== 'continue') {
    throw new GitError(`Unknown step: ${step}`);
  }
  const operation = await operationInProgress(cwd);
  if (!operation) {
    throw new GitError('No merge, rebase, cherry-pick or revert in progress');
  }
  if (operation === 'merge' && step === 'continue') {
    return run(cwd, ['commit', '--no-edit']);
  }
  // GIT_EDITOR=true accepts the prepared commit message instead of opening an editor
  return run(cwd, [operation, `--${step}`], { env: { GIT_EDITOR: 'true' } });
}

async function stashList(cwd) {
  const { stdout } = await run(cwd, ['stash', 'list', '--format=%gd%x1f%cr%x1f%gs']);
  return stdout.split('\n').filter(Boolean).map(line => {
    const [ref, date, subject] = line.split('\x1f');
    return { ref, date, subject };
  });
}

async function stashPush(cwd, message) {
  const args = ['stash', 'push', '--include-untracked'];
  if (message && message.trim()) args.push('-m', message.trim());
  return run(cwd, args);
}

function validateStashRef(ref) {
  if (!/^stash@\{\d+\}$/.test(ref)) {
    throw new GitError(`Invalid stash reference: ${ref}`);
  }
}

async function stashApply(cwd, ref, { pop = false } = {}) {
  validateStashRef(ref);
  return run(cwd, ['stash', pop ? 'pop' : 'apply', ref]);
}

async function stashDrop(cwd, ref) {
  validateStashRef(ref);
  return run(cwd, ['stash', 'drop', ref]);
}

async function branches(cwd) {
  const { stdout } = await run(cwd, [
    'for-each-ref',
    '--format=%(refname)%09%(HEAD)%09%(upstream:short)',
    'refs/heads',
    'refs/remotes'
  ]);

  const local = [];
  const remote = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [ref, head, upstream] = line.split('\t');
    if (ref.startsWith('refs/heads/')) {
      local.push({ name: ref.slice('refs/heads/'.length), current: head === '*', upstream: upstream || null });
    } else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
      remote.push({ name: ref.slice('refs/remotes/'.length) });
    }
  }
  return { local, remote };
}

async function validateBranchName(cwd, name) {
  try {
    await run(cwd, ['check-ref-format', '--branch', name]);
  } catch {
    throw new GitError(`Invalid branch name: ${name}`);
  }
}

async function checkout(cwd, branch) {
  await validateBranchName(cwd, branch);
  return run(cwd, ['switch', branch]);
}

/**
 * Create a local branch tracking a remote branch (e.g. "origin/feature") and switch to it.
 * Explicit, so it works when several remotes have a branch with the same name.
 */
async function checkoutRemote(cwd, remoteBranch) {
  try {
    await run(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteBranch}`]);
  } catch {
    throw new GitError(`Unknown remote branch: ${remoteBranch}`);
  }
  return run(cwd, ['switch', '--track', `${remoteBranch}`]);
}

async function createBranch(cwd, name) {
  await validateBranchName(cwd, name);
  return run(cwd, ['switch', '-c', name]);
}

async function diff(cwd, file, { staged = false, untracked = false } = {}) {
  if (untracked) {
    // Exit code 1 means "differences found" for --no-index
    const { stdout } = await run(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', file], { okCodes: [0, 1] });
    return stdout;
  }
  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  args.push('--', file);
  const { stdout } = await run(cwd, args);
  return stdout;
}

async function log(cwd, count = 20) {
  try {
    const { stdout } = await run(cwd, ['log', `-n${count}`, '--format=%h%x1f%an%x1f%ar%x1f%s']);
    return stdout.split('\n').filter(Boolean).map(line => {
      const [hash, author, date, subject] = line.split('\x1f');
      return { hash, author, date, subject };
    });
  } catch {
    return []; // No commits yet
  }
}

async function clone(parentDir, url, dirName) {
  return runNetwork(parentDir, ['clone', '--', url, dirName]);
}

module.exports = {
  GitError,
  setGithubToken,
  run,
  parseStatus,
  status,
  remotes,
  remoteList,
  addRemote,
  renameRemote,
  setRemoteUrl,
  removeRemote,
  commonDir,
  fetch,
  pull,
  push,
  stage,
  unstage,
  commit,
  branches,
  checkout,
  checkoutRemote,
  createBranch,
  discard,
  lastCommitMessage,
  operationInProgress,
  resolveOperation,
  stashList,
  stashPush,
  stashApply,
  stashDrop,
  diff,
  log,
  clone
};
