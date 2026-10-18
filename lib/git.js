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
    this.hint = null; // Plain-language explanation shown next to git's own output
    this.reason = null; // Machine-readable cause the UI can offer a next step for
  }

  /**
   * Add an explanation to the message, keeping git's output in front of it
   */
  addHint(hint) {
    this.hint = this.hint ? `${this.hint}\n${hint}` : hint;
    this.message += `\n\nHint: ${hint}`;
    return this;
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
 * @param {Object} options - { timeout, okCodes, env, network }
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function run(cwd, args, { timeout = LOCAL_TIMEOUT, okCodes = [0], env: extraEnv = {}, network = false } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...extraEnv };

  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      if (okCodes.includes(code)) {
        resolve({ stdout, stderr, code });
        return;
      }
      const gitError = new GitError((stderr || stdout || error.message).trim(), { stdout, stderr, code });
      if (error.killed) {
        // Killed by the timeout: the partial output alone doesn't say what went wrong
        const command = args.find(arg => !arg.startsWith('-')) || 'command';
        gitError.addHint(`git ${command} timed out after ${Math.round(timeout / 1000)}s.` +
          (network ? ' Check your network and that the remote doesn\'t wait for a password or passphrase.' : ''));
      }
      reject(gitError);
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

// Causes of network failures that git words obscurely (its last line is often just
// "Could not read from remote repository"), with what to do about them
const NETWORK_HINTS = [
  [/could not read (Username|Password)|terminal prompts disabled/i,
    'There are no saved credentials for this HTTPS remote, and the app can\'t ask for a password. ' +
    'For github.com, set GITHUB_TOKEN in .env; otherwise save credentials with a git credential helper, or use an SSH remote.'],
  [/Authentication failed|Invalid username or password|returned error: 40[13]/i,
    'The remote rejected the credentials. The saved password or token may be expired or lack access ' +
    '(a GitHub token needs the repo scope).'],
  [/Permission denied \(publickey/i,
    'The SSH key was refused or isn\'t available. The app runs ssh without prompts, so a key with a passphrase ' +
    'must be loaded into ssh-agent (ssh-add) where the server was started.'],
  [/Host key verification failed/i,
    'The remote\'s SSH host key isn\'t trusted yet. Connect once from a terminal (e.g. ssh -T git@github.com) and accept it.'],
  [/Could not resolve host|Network is unreachable|Connection timed out|Failed to connect|Connection refused|Operation timed out/i,
    'The remote can\'t be reached. Check your network, VPN or proxy.'],
  [/Repository not found|does not appear to be a git repository/i,
    'The repository doesn\'t exist at this URL, or your credentials can\'t see it.']
];

async function runNetwork(cwd, args) {
  try {
    return await run(cwd, args, { timeout: NETWORK_TIMEOUT, env: await networkEnv(cwd), network: true });
  } catch (error) {
    const known = error instanceof GitError && !error.hint && NETWORK_HINTS.find(([pattern]) => pattern.test(error.message));
    if (known) error.addHint(known[1]);
    throw error;
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output
 */
function parseStatus(output) {
  const result = {
    branch: null,
    oid: null,
    upstream: null,
    upstreamGone: false, // The upstream is configured but the remote branch no longer exists
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: []
  };

  const tokens = output.split('\0');
  let sawAheadBehind = false;
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
        sawAheadBehind = true;
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

  // git leaves out ahead/behind when the upstream's remote-tracking branch is missing
  result.upstreamGone = Boolean(result.upstream) && !sawAheadBehind;
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

async function configGet(cwd, key) {
  const { stdout } = await run(cwd, ['config', '--get', key], { okCodes: [0, 1] });
  return stdout.trim() || null;
}

/**
 * The remotes a plain `git pull` and `git push` use for a branch
 * @returns {Promise<{pull: string|null, push: string|null}>}
 */
async function branchRemotes(cwd, branch) {
  if (!branch) return { pull: null, push: null };
  const [upstream, pushRemote, pushDefault] = await Promise.all([
    configGet(cwd, `branch.${branch}.remote`),
    configGet(cwd, `branch.${branch}.pushRemote`),
    configGet(cwd, 'remote.pushDefault')
  ]);
  // "." means the upstream is a local branch, not a remote
  const pull = upstream === '.' ? null : upstream;
  return { pull, push: pushRemote || pushDefault || pull };
}

/**
 * How the current branch compares to its counterpart on each remote: the upstream for the
 * remote it tracks, otherwise the branch of the same name
 * @param {string} cwd - Repository path
 * @param {Object} status - Parsed status of the repository
 * @param {string[]} remoteNames - Remotes to compare against
 * @returns {Promise<{defaults: Object, branches: Object}>} branches: remote -> { ref, ahead, behind } or null
 */
async function remoteTracking(cwd, status, remoteNames) {
  const defaults = await branchRemotes(cwd, status.branch);
  const branches = {};
  if (!status.branch) return { defaults, branches };
  await Promise.all(remoteNames.map(async remote => {
    const ref = remote === defaults.pull && status.upstream ? status.upstream : `${remote}/${status.branch}`;
    try {
      const { stdout } = await run(cwd, ['rev-list', '--left-right', '--count', `HEAD...refs/remotes/${ref}`, '--']);
      const [ahead, behind] = stdout.trim().split(/\s+/).map(Number);
      branches[remote] = { ref, ahead, behind };
    } catch {
      branches[remote] = null; // The remote has no such branch (or nothing fetched yet)
    }
  }));
  return { defaults, branches };
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
 * @param {string|null} remote - Pull the branch of the same name from this remote instead
 *   of the upstream. The remote the branch tracks pulls the upstream as usual. A branch
 *   without an upstream pulls its namesake from origin (or the only remote), the branch
 *   a push would publish it to.
 */
async function pull(cwd, mode = 'default', remote = null) {
  const flags = PULL_MODES[mode];
  if (!flags) {
    throw new GitError(`Unknown pull mode: ${mode}`);
  }
  const st = await status(cwd);
  if (!st.branch) {
    throw new GitError('Cannot pull into a detached HEAD. Switch to a branch first.');
  }
  let target = remote;
  if (target !== null) {
    await requireRemote(cwd, target);
  } else if (!st.upstream) {
    const names = Object.keys(await remotes(cwd));
    target = names.includes('origin') ? 'origin' : names[0];
    if (!target) {
      throw new GitError('No remote configured. Add a remote to pull from.');
    }
  }
  const args = ['pull', ...flags];
  if (target !== null && target !== (await branchRemotes(cwd, st.branch)).pull) {
    args.push('--', target, st.branch);
  }
  try {
    return await runNetwork(cwd, args);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    if (/divergent branches|Not possible to fast-forward/i.test(error.message)) {
      error.reason = 'diverged';
      error.addHint('Your branch and its upstream have diverged. Choose "rebase" or "merge" as the pull mode.');
    } else if (/couldn't find remote ref/i.test(error.message)) {
      error.addHint(`${target} has no branch ${st.branch}. Push to publish it there.`);
    } else if (/no such ref was fetched/i.test(error.message)) {
      error.addHint(`The upstream ${st.upstream} no longer exists on the remote. Push to recreate it, or switch to another branch.`);
    }
    throw error;
  }
}

/**
 * Where a plain push should go when git would refuse it: with push.default "simple" (git's
 * default) a push to the upstream's remote refuses an upstream of another name, e.g. main
 * tracking origin/master. Pushing to the tracked branch is what the user set up, so name it.
 * @returns {Promise<string[]>} Extra push arguments; empty when a plain push works
 */
async function upstreamRefspec(cwd, branch, defaults) {
  if (!defaults.pull || defaults.push !== defaults.pull) return [];
  const [merge, pushDefault] = await Promise.all([
    configGet(cwd, `branch.${branch}.merge`),
    configGet(cwd, 'push.default')
  ]);
  const upstreamBranch = merge && merge.replace(/^refs\/heads\//, '');
  if (!upstreamBranch || upstreamBranch === branch) return [];
  if (pushDefault && pushDefault !== 'simple') return [];
  return ['--', defaults.pull, `HEAD:refs/heads/${upstreamBranch}`];
}

/**
 * Push the current branch, setting its upstream on first push.
 * @param {string} cwd - Repository path
 * @param {Object} options - { force, remote }
 *   force: use --force-with-lease (e.g. after amending a pushed commit)
 *   remote: push to the branch of the same name on this remote instead of where git would push
 */
async function push(cwd, { force = false, remote = null } = {}) {
  const st = await status(cwd);
  if (!st.branch) {
    throw new GitError('Cannot push from a detached HEAD');
  }
  const forceFlags = force ? ['--force-with-lease'] : [];
  let args;
  if (remote !== null) {
    await requireRemote(cwd, remote);
  }

  if (!st.upstream) {
    if (remote === null) {
      const remoteMap = await remotes(cwd);
      remote = remoteMap.origin ? 'origin' : Object.keys(remoteMap)[0];
      if (!remote) {
        throw new GitError('No remote configured');
      }
    }
    args = ['push', ...forceFlags, '-u', '--', remote, st.branch];
  } else {
    const defaults = await branchRemotes(cwd, st.branch);
    if (remote !== null && remote !== defaults.push) {
      args = ['push', ...forceFlags, '--', remote, st.branch];
    } else {
      args = ['push', ...forceFlags, ...(await upstreamRefspec(cwd, st.branch, defaults))];
    }
  }

  try {
    return await runNetwork(cwd, args);
  } catch (error) {
    if (!force && error instanceof GitError && /\[rejected\]|non-fast-forward|fetch first/i.test(error.message)) {
      error.reason = 'rejected';
      error.addHint('The remote has commits you don\'t have. Pull first, or use "Force push" if you amended or rebased commits that were already pushed.');
    }
    throw error;
  }
}

/**
 * Fast-forward the current branch to its upstream as last fetched, without fetching
 */
async function fastForward(cwd) {
  return run(cwd, ['merge', '--ff-only', '@{upstream}']);
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
  remoteTracking,
  addRemote,
  renameRemote,
  setRemoteUrl,
  removeRemote,
  commonDir,
  fetch,
  pull,
  fastForward,
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
