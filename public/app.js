'use strict';

const PULL_MODES = [
  ['default', 'Pull (git config)'],
  ['ff-only', 'Pull (fast-forward only)'],
  ['rebase', 'Pull (rebase)'],
  ['merge', 'Pull (merge)']
];

// Coming back to the window after at least this long quietly refreshes statuses
const RETURN_REFRESH_MS = 10 * 1000;
// Ahead/behind are only as fresh as the last fetch, so the app fetches everything when it
// opens and when the user comes back after at least this long
const AUTO_FETCH_MS = 15 * 60 * 1000;

const state = {
  locals: null, // Top-level local repositories (worktrees nested) from the last scan
  account: null, // { repos } or { error }; null until GitHub answers
  scanRoot: '',
  syncAbort: null, // AbortController of the running /api/sync stream
  syncProgress: null, // { done, total } while statuses stream in
  statusAt: {}, // id -> when an action last reported its status, so older stream data can't undo it
  selectedId: null,
  detail: null,
  detailError: null, // Why the selected repository's detail couldn't be loaded
  detailSeq: 0, // Bumped on every detail update so stale responses are ignored
  selectedFile: null, // { path, kind: 'staged' | 'unstaged' | 'untracked' | 'conflicted' }
  diff: null,
  diffInfo: null, // { totalLines, truncated } of the loaded diff
  diffSeq: 0,
  showAllFiles: new Set(), // File lists ('staged', 'unstaged', ...) shown in full despite their length
  outputs: {}, // id -> { text, error, retry }: the last action's output per repository
  revealOutput: null, // id whose new output should be scrolled into view on the next render
  bulk: null, // Shown bulk result: { kind, running, done, total, lines, counts, error }
  bulkRun: null, // The running bulk operation (a quiet auto-fetch isn't shown in state.bulk)
  autoFetch: readSetting('autoFetch', '1') === '1',
  lastAutoFetch: 0,
  drafts: emptyDrafts(),
  remoteEdit: null, // { name, newName, url, pushUrl } while a remote is being edited
  amend: false,
  pullMode: PULL_MODES.some(([mode]) => mode === readSetting('pullMode')) ? readSetting('pullMode') : 'default',
  filter: '',
  viewFilter: 'all',
  busy: new Set(),
  collab: null // { loading, total, checked, rows, failed, error }
};

// ---------- helpers ----------

// Remotes picked for pull and push, per repository: { pull, push }. A missing key means
// git's default (the upstream's remote, or the push remote from git config).
function remoteChoice(id) {
  try {
    return JSON.parse(readSetting(`remotes:${id}`, '{}'));
  } catch {
    return {};
  }
}

function saveRemoteChoice(id, choice) {
  writeSetting(`remotes:${id}`, JSON.stringify(choice));
  scheduleRows([id]); // The row's Pull and Push buttons use the choice too
}

function setRemoteChoice(id, kind, remote, defaultRemote) {
  const choice = remoteChoice(id);
  if (remote === defaultRemote) delete choice[kind];
  else choice[kind] = remote;
  saveRemoteChoice(id, choice);
}

/**
 * Forget picks of remotes that no longer exist, so the row buttons don't send them
 */
function pruneRemoteChoice(detail) {
  const choice = remoteChoice(detail.id);
  const names = new Set(detail.remotes.map(r => r.name));
  const stale = ['pull', 'push'].filter(kind => choice[kind] && !names.has(choice[kind]));
  if (stale.length === 0) return;
  stale.forEach(kind => delete choice[kind]);
  saveRemoteChoice(detail.id, choice);
}

function remoteBody(remote) {
  return remote ? { remote } : {};
}

function emptyDrafts() {
  return { commit: '', branch: '', stash: '', remoteName: '', remoteUrl: '' };
}

function readSetting(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writeSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode); the setting just won't persist
  }
}

/**
 * Create a DOM element. Children may be strings, nodes, arrays or falsy values.
 * Text is always set with textContent so repo data can't inject HTML.
 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  appendAll(el, nodes(children));
  return el;
}

/**
 * Append nodes in chunks: spreading a very long list as arguments overflows the call stack
 */
function appendAll(el, list) {
  for (let i = 0; i < list.length; i += 10000) el.append(...list.slice(i, i + 10000));
}

/**
 * Flatten children into nodes, dropping falsy values
 */
function nodes(children) {
  return [children].flat(Infinity)
    .filter(child => child !== null && child !== undefined && child !== false)
    .map(child => (child instanceof Node ? child : document.createTextNode(String(child))));
}

async function api(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      'X-Requested-With': 'repo-collaborators',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.data = data;
    throw error;
  }
  return data;
}

/**
 * Read a newline-delimited JSON stream and call onEvent for each event as it arrives
 */
async function stream(url, onEvent, { method = 'GET', signal } = {}) {
  const response = await fetch(url, { method, signal, headers: { 'X-Requested-With': 'repo-collaborators' } });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === 'error') throw new Error(event.error);
        onEvent(event);
      }
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
}

const MAX_TOASTS = 3;

/**
 * Show a short message in the corner. Click to dismiss; only the newest few stay
 * so they don't pile up over the page.
 */
function toast(message, isError = false) {
  const container = document.getElementById('toasts');
  const el = h('div', { class: `toast${isError ? ' error' : ''}`, title: 'Click to dismiss', onclick: () => el.remove() }, message);
  container.append(el);
  while (container.children.length > MAX_TOASTS) container.firstElementChild.remove();
  setTimeout(() => el.remove(), isError ? 8000 : 4000);
}

/**
 * Run an async task while marking `key` busy, so buttons can show a spinner
 */
async function withBusy(key, fn) {
  if (state.busy.has(key)) return;
  setBusy(key, true);
  try {
    return await fn();
  } finally {
    setBusy(key, false);
  }
}

/**
 * Mark a key busy or idle and re-render only what shows it: a repository row (and the
 * detail panel when it is the selected repository), a clone row, or a toolbar button
 */
function setBusy(key, busy) {
  if (busy) state.busy.add(key);
  else state.busy.delete(key);

  const id = key.includes(':') ? key.slice(0, key.indexOf(':')) : null;
  if (key.startsWith('clone:')) {
    scheduleListRender();
  } else if (id && findLocal(id)) {
    scheduleRows([id]);
    if (id === state.selectedId) renderDetail();
  } else {
    renderToolbar();
  }
}

/**
 * Whether an action is running on a repository. Bulk fetches (":sync") don't count:
 * the server queues work per repository, so an action started meanwhile just waits.
 */
function repoBusy(id) {
  const prefix = `${id}:`;
  return [...state.busy].some(key => key.startsWith(prefix) && key !== `${id}:sync`);
}

function busyLabel(key, label) {
  return state.busy.has(key) ? [h('span', { class: 'spinner' }), ' ', label] : label;
}

/**
 * The line of a git error that says what went wrong: the app's hint, else git's fatal,
 * rejected or error line, else the first line that isn't progress ("From …", "To …") or advice
 */
function errorSummary(message) {
  const text = String(message || '');
  const hint = text.match(/\n\nHint: (.+)/);
  if (hint) return hint[1];
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const fatal = lines.find(line => /^fatal:/i.test(line)) ||
    lines.find(line => /^! \[(remote )?rejected\]/.test(line)) ||
    lines.find(line => /^error:/i.test(line));
  if (fatal) return fatal.replace(/^(fatal|error):\s*/i, '');
  return lines.find(line => !/^(From |To |hint:|remote:|[0-9a-f]+\.\.[0-9a-f]+ )/i.test(line)) || lines[0] || 'Unknown error';
}

function allLocals() {
  return (state.locals || []).flatMap(local => [local, ...local.worktrees]);
}

function findLocal(id) {
  return allLocals().find(local => local.id === id) || null;
}

// ---------- render scheduling ----------

// Updates are batched per animation frame: a full list rebuild when the structure changed,
// otherwise only the rows whose status or busy state changed
const pending = { list: false, rows: new Set(), collab: false, frame: 0 };

function scheduleListRender() {
  pending.list = true;
  scheduleFrame();
}

function scheduleRows(ids) {
  ids.forEach(id => pending.rows.add(id));
  scheduleFrame();
}

function scheduleCollabRender() {
  pending.collab = true;
  scheduleFrame();
}

function scheduleFrame() {
  if (!pending.frame) pending.frame = requestAnimationFrame(flushRender);
}

function flushRender() {
  pending.frame = 0;
  const rows = [...pending.rows];
  pending.rows.clear();
  // In the "Changes" and "Ahead / behind" views a status change can add or remove rows
  if (pending.list || (rows.length > 0 && state.viewFilter !== 'all')) {
    pending.list = false;
    renderRepoList();
  } else {
    rows.forEach(patchRow);
  }
  if (pending.collab) {
    pending.collab = false;
    renderCollaborators();
  }
}

// ---------- data loading ----------

async function loadUser() {
  const el = document.getElementById('user');
  try {
    const user = await api('/api/me');
    el.replaceChildren(h('img', { src: user.avatarUrl, alt: '' }), h('span', {}, user.login));
  } catch (error) {
    el.replaceChildren(h('span', {}, 'Not connected to GitHub'));
  }
}

/**
 * Stream the sync view: GitHub repos, local repos, then one status per repository.
 * Rows appear right after the disk scan and fill in as their statuses arrive.
 * A quiet load (coming back to the window) shows no progress and yields to a running load.
 */
async function loadSync({ rescan = false, refresh = false, quiet = false } = {}) {
  if (quiet && state.syncAbort) return;
  if (state.syncAbort) state.syncAbort.abort();
  const controller = new AbortController();
  state.syncAbort = controller;
  state.syncProgress = quiet ? null : { done: 0, total: null };
  renderSyncProgress();

  const startedAt = Date.now();
  const params = new URLSearchParams();
  if (rescan) params.set('rescan', '1');
  if (refresh) params.set('refresh', '1');

  try {
    await stream(`/api/sync?${params}`, event => {
      if (event.type === 'account') {
        const account = event.error ? { error: event.error } : { repos: event.repos };
        // Unchanged data (the usual case on a refresh) leaves the list as it is
        if (JSON.stringify(account) !== JSON.stringify(state.account)) {
          state.account = account;
          scheduleListRender();
        }
      } else if (event.type === 'locals') {
        state.scanRoot = event.scanRoot;
        if (setLocals(event.locals)) scheduleListRender();
        if (state.syncProgress) state.syncProgress.total = allLocals().length;
      } else if (event.type === 'status') {
        if (state.syncProgress) state.syncProgress.done++;
        // An action that finished after this load started has the newer status
        if (!(state.statusAt[event.id] > startedAt)) setStatus(event.id, event.status);
      }
      renderSyncProgress();
    }, { signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') return;
    toast(error.message, true);
  } finally {
    if (state.syncAbort === controller) {
      state.syncAbort = null;
      state.syncProgress = null;
      renderSyncProgress();
    }
  }
}

/**
 * Replace the scanned repositories, keeping statuses already known so rows don't blank out.
 * Returns whether the set of repositories changed.
 */
function setLocals(locals) {
  const shape = list => JSON.stringify(list, (key, value) => (key === 'status' ? undefined : value));
  const changed = !state.locals || shape(locals) !== shape(state.locals);
  const known = new Map(allLocals().map(local => [local.id, local.status]));
  state.locals = locals;
  for (const local of allLocals()) local.status = known.get(local.id) || null;

  if (state.selectedId && !findLocal(state.selectedId)) {
    state.selectedId = null;
    state.detail = null;
    closeDiff();
    renderDetail();
  }
  return changed;
}

function setStatus(id, status) {
  const local = findLocal(id);
  if (!local) return;
  const changed = JSON.stringify(status) !== JSON.stringify(local.status);
  local.status = status;
  if (changed) scheduleRows([id]);
}

/**
 * Apply the repository list sent after a remote change (its GitHub match may have changed)
 */
function applyLocals(locals) {
  if (locals && setLocals(locals)) scheduleListRender();
}

/**
 * Apply statuses reported by an action or a bulk operation
 */
function applySummaries(summaries) {
  if (!summaries) return;
  const now = Date.now();
  for (const [id, status] of Object.entries(summaries)) {
    state.statusAt[id] = now;
    setStatus(id, status);
  }
}

/**
 * Load the detail for a repository. Responses that arrive after a newer selection
 * or update are dropped, and an unchanged detail isn't re-rendered.
 */
async function loadDetail(id) {
  const seq = ++state.detailSeq;
  try {
    const detail = await api(`/api/repo/status?id=${encodeURIComponent(id)}`);
    if (seq !== state.detailSeq || id !== state.selectedId) return;
    pruneRemoteChoice(detail);
    const unchanged = JSON.stringify(detail) === JSON.stringify(state.detail);
    state.detail = detail;
    state.detailError = null;
    await refreshSelectedFileDiff();
    if (unchanged) return;
  } catch (error) {
    if (seq !== state.detailSeq || id !== state.selectedId) return;
    state.detail = null;
    state.detailError = error.message; // Shown in the panel instead of a spinner
  }
  renderDetail();
}

async function selectRepo(id) {
  if (state.selectedId !== id) {
    closeDiff();
    state.showAllFiles = new Set();
    state.drafts = emptyDrafts();
    state.remoteEdit = null;
    state.amend = false;
    state.detail = null;
  }
  state.detailError = null;
  state.selectedId = id;
  markSelectedRow();
  renderDetail();
  await loadDetail(id);
}

function closeDiff() {
  state.selectedFile = null;
  state.diff = null;
  state.diffInfo = null;
  state.diffSeq++;
}

async function loadDiff() {
  const file = state.selectedFile;
  if (!file || !state.detail) {
    state.diff = null;
    return;
  }
  const seq = ++state.diffSeq;
  const params = new URLSearchParams({
    id: state.detail.id,
    file: file.path,
    staged: file.kind === 'staged' ? '1' : '0',
    untracked: file.kind === 'untracked' ? '1' : '0',
    full: file.full ? '1' : '0'
  });
  try {
    const { diff, totalLines, truncated } = await api(`/api/repo/diff?${params}`);
    if (seq !== state.diffSeq || diff === state.diff) return;
    state.diff = diff;
    state.diffInfo = { totalLines, truncated };
  } catch (error) {
    if (seq !== state.diffSeq) return;
    state.diff = '';
    toast(error.message, true);
  }
  renderDetail();
}

/**
 * Apply a fresh detail (from an action response) if it belongs to the selected repository
 */
async function applyDetail(id, detail) {
  if (!detail) return;
  pruneRemoteChoice(detail);
  if (id !== state.selectedId) return;
  state.detailSeq++; // Invalidate any slower in-flight loadDetail
  state.detail = detail;
  state.detailError = null;
  await refreshSelectedFileDiff();
}

/**
 * Run a git action on a repository, then refresh its detail and its list summary
 */
const PULL_FLAGS = { 'ff-only': ' --ff-only', rebase: ' --rebase', merge: ' --no-rebase' };

/**
 * @param {Object} options - { fromList }: started from a list row. Its result is a toast,
 *   and the page doesn't scroll to the output box (below the list on narrow screens).
 */
async function runAction(id, action, body = {}, { fromList = false } = {}) {
  // Shown as "$ git <label>" above the output
  const label = action.replace('-', ' ') + (action === 'pull' ? PULL_FLAGS[body.mode] || '' : '');
  if (repoBusy(id)) {
    toast(`${repoName(id)}: wait for the running action to finish`, true);
    // Controls that already changed (the branch selector) go back to the actual state
    if (id === state.selectedId) renderDetail();
    return false;
  }
  return withBusy(`${id}:${action}`, async () => {
    try {
      const result = await api(`/api/repo/${action}`, { method: 'POST', body: { id, ...body } });
      applyLocals(result.locals);
      applySummaries(result.summaries);
      await applyDetail(id, result.detail);
      const network = ['fetch', 'pull', 'push'].includes(action);
      // Kept per repository, so a pull from the list shows its output when the repository is opened
      if (result.output || network) {
        state.outputs[id] = { text: `$ git ${label}\n${result.output || 'Nothing new.'}`, error: false };
      } else {
        delete state.outputs[id];
      }
      // The open repository shows the result in its output box
      const inPanel = id === state.selectedId && !fromList;
      if (inPanel) state.revealOutput = id;
      else if (network) toast(`${repoName(id)}: ${label} – ${successSummary(action, result.output)}`);
      return true;
    } catch (error) {
      applyLocals(error.data?.locals);
      applySummaries(error.data?.summaries);
      await applyDetail(id, error.data?.detail);
      const details = [error.data?.stdout, error.data?.stderr].filter(Boolean).join('\n').trim();
      const hint = details && error.data?.hint ? `\n\nHint: ${error.data.hint}` : '';
      state.outputs[id] = {
        text: `$ git ${label}\n${details || error.message}${hint}`,
        error: true,
        retry: retryChoices(action, body, error.data?.reason)
      };
      if (id === state.selectedId && !fromList) state.revealOutput = id;
      else toast(`${repoName(id)}: ${label} failed – ${errorSummary(error.message)}`, true);
      return false;
    }
  });
}

/**
 * Next steps to offer as buttons after a pull or push failed for a known reason
 */
function retryChoices(action, body, reason) {
  const remote = remoteBody(body.remote);
  if (action === 'pull' && reason === 'diverged') {
    return [
      { label: 'Pull with rebase', action: 'pull', body: { ...remote, mode: 'rebase' } },
      { label: 'Pull with merge', action: 'pull', body: { ...remote, mode: 'merge' } }
    ];
  }
  if (action === 'push' && reason === 'rejected') {
    return [{ label: 'Pull first', action: 'pull', body: { ...remote, mode: state.pullMode } }];
  }
  return null;
}

function repoName(id) {
  return findLocal(id)?.name || 'repository';
}

/**
 * What a successful fetch, pull or push did, in a few words
 */
function successSummary(action, output) {
  const text = output || '';
  if (action === 'fetch') {
    const updated = text.split('\n').filter(line => / -> /.test(line)).length;
    return updated ? `${updated} branch${updated === 1 ? '' : 'es'} updated` : 'nothing new';
  }
  if (/Already up to date|Everything up-to-date/i.test(text)) {
    return action === 'push' ? 'nothing to push' : 'already up to date';
  }
  if (action === 'pull') {
    if (/Successfully rebased/i.test(text)) return 'rebased onto the remote';
    const files = text.match(/\d+ files? changed/);
    return files ? `updated, ${files[0]}` : 'updated';
  }
  return /\[new branch\]/.test(text) ? 'published the branch' : 'pushed';
}

/**
 * Keep the open diff in sync after an action: follow the file to its new list or close it
 */
async function refreshSelectedFileDiff() {
  const file = state.selectedFile;
  if (!file || !state.detail) return;
  const st = state.detail.status;
  const lists = { staged: st.staged, unstaged: st.unstaged, untracked: st.untracked, conflicted: st.conflicted };
  if (!lists[file.kind].some(f => f.path === file.path)) {
    const kind = Object.keys(lists).find(k => lists[k].some(f => f.path === file.path));
    if (!kind) {
      closeDiff();
      return;
    }
    file.kind = kind;
  }
  await loadDiff();
}

async function cloneRepo(fullName) {
  await withBusy(`clone:${fullName}`, async () => {
    try {
      const result = await api('/api/clone', { method: 'POST', body: { fullName } });
      toast(`Cloned into ${result.path}`);
      await loadSync();
    } catch (error) {
      toast(`Clone failed: ${errorSummary(error.message)}`, true);
    }
  });
}

/**
 * Fetch all or pull all. Each repository's result shows up as soon as it is done.
 * A quiet run (auto-fetch) shows only row spinners and toolbar progress, and its result
 * panel only when something failed.
 */
async function runBulk(kind, { quiet = false } = {}) {
  if (state.busy.has('fetch-all') || state.busy.has('pull-all')) return;
  await withBusy(`${kind}-all`, async () => {
    const bulk = {
      kind,
      running: true,
      done: 0,
      total: null,
      lines: [],
      counts: { pulled: 0, current: 0, skipped: 0, failed: 0 },
      error: false
    };
    state.bulkRun = bulk;
    if (!quiet) state.bulk = bulk;
    const syncing = new Set();
    const finishRepo = id => {
      if (syncing.delete(id)) setBusy(`${id}:sync`, false);
      bulk.done++;
    };

    try {
      await stream(`/api/sync/${kind}-all`, event => {
        if (event.type === 'start') {
          bulk.total = event.total;
        } else if (event.type === 'begin') {
          syncing.add(event.id);
          setBusy(`${event.id}:sync`, true);
        } else if (event.type === 'fetched') {
          finishRepo(event.id);
          if (!event.ok) {
            bulk.counts.failed++;
            bulk.lines.push(`✗ ${event.relPath}: ${errorSummary(event.error)}`);
          }
          applySummaries(event.summaries);
        } else if (event.type === 'group') {
          finishRepo(event.id);
          for (const result of event.results) {
            bulk.counts[result.kind]++;
            if (result.kind !== 'current') bulk.lines.push(pullResultLine(result));
          }
          applySummaries(event.summaries);
        }
        renderBulkResult();
        renderToolbar();
      }, { method: 'POST' });
    } catch (error) {
      bulk.lines.push(`✗ ${error.message}`);
      bulk.counts.failed++;
      toast(error.message, true);
    } finally {
      syncing.forEach(id => setBusy(`${id}:sync`, false));
      bulk.running = false;
      bulk.error = bulk.counts.failed > 0;
      state.bulkRun = null;
      if (quiet && bulk.error) {
        bulk.lines.unshift('Automatic fetch:');
        state.bulk = bulk;
      }
      renderBulkResult();
    }
    if (state.selectedId) loadDetail(state.selectedId);
  });
}

/**
 * Fetch everything in the background, unless switched off or already done recently
 */
function autoFetch({ force = false } = {}) {
  if (!state.autoFetch) return;
  if (!force && Date.now() - state.lastAutoFetch < AUTO_FETCH_MS) return;
  state.lastAutoFetch = Date.now();
  runBulk('fetch', { quiet: true });
}

function timeAgo(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function fetchedText(status) {
  return status?.fetchedAt ? `fetched ${timeAgo(status.fetchedAt)}` : 'never fetched';
}

function pullResultLine(result) {
  if (result.kind === 'pulled') {
    return `✓ ${result.relPath}: ${result.commits} new commit${result.commits === 1 ? '' : 's'}`;
  }
  if (result.kind === 'skipped') return `– ${result.relPath}: skipped, ${result.reason}`;
  return `✗ ${result.relPath}: ${errorSummary(result.error)}`;
}

/**
 * Stream the collaborators table; rows show up as each repository is checked
 */
async function loadCollaborators(refresh = false) {
  if (state.collab?.loading) return;
  const collab = { loading: true, total: null, checked: 0, rows: [], failed: [], error: null };
  state.collab = collab;
  renderCollaborators();
  try {
    await stream(`/api/collaborators${refresh ? '?refresh=1' : ''}`, event => {
      if (event.type === 'start') {
        collab.total = event.total;
      } else if (event.type === 'result') {
        collab.checked++;
        if (event.row) {
          collab.rows.push({ index: event.index, ...event.row });
          collab.rows.sort((a, b) => a.index - b.index);
        }
        if (event.failed) collab.failed.push(event.failed);
      }
      scheduleCollabRender();
    });
  } catch (error) {
    collab.error = error.message;
  }
  collab.loading = false;
  renderCollaborators();
}

// ---------- rendering: collaborators ----------

function progressBar(done, total) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  return h('div', { class: `progress${total ? '' : ' indeterminate'}` },
    h('div', { class: 'progress-fill', style: total ? `width:${percent}%` : null }));
}

function renderCollaborators() {
  const container = document.getElementById('collab-content');
  const button = document.getElementById('btn-refresh-collab');
  const collab = state.collab;
  const loading = Boolean(collab?.loading);
  button.disabled = loading;
  button.replaceChildren(...nodes(loading ? [h('span', { class: 'spinner' }), ' Refresh'] : 'Refresh'));
  if (!collab) return;

  const status = collab.loading && h('div', { class: 'collab-progress' },
    h('div', { class: 'muted' }, collab.total === null
      ? 'Loading your repositories…'
      : `Checking collaborators: ${collab.checked} of ${collab.total} repositories`),
    progressBar(collab.checked, collab.total));
  const warning = !collab.loading && collab.failed.length > 0 && h('div', { class: 'notice' },
    `Couldn't load collaborators for ${collab.failed.length} repositories because GitHub rate-limited the requests. ` +
    `Press Refresh later to retry: ${collab.failed.join(', ')}`);
  const error = collab.error && h('div', { class: 'notice' }, collab.error);

  let body = null;
  if (collab.rows.length > 0) {
    body = h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Repository'), h('th', {}, 'Collaborators'), h('th', {}, 'Owner'))),
      h('tbody', {}, collab.rows.map(row => h('tr', {},
        h('td', {}, h('a', { href: row.url, target: '_blank', rel: 'noopener' }, row.repoName)),
        h('td', {}, row.others),
        h('td', {}, row.owner)
      ))));
  } else if (!collab.loading && !collab.error) {
    body = h('div', { class: 'empty' }, 'No repositories with other collaborators found.');
  }
  container.replaceChildren(...nodes([status, error, warning, body]));
}

// ---------- rendering: repository list ----------

function matchesFilter(texts, local) {
  const q = state.filter.trim().toLowerCase();
  if (q && !texts.some(t => t && t.toLowerCase().includes(q))) return false;
  if (state.viewFilter === 'all') return true;
  const locals = Array.isArray(local) ? local : [local];
  const all = locals.flatMap(l => [l, ...(l.worktrees || [])]);
  if (state.viewFilter === 'dirty') return all.some(l => l.status?.changes > 0);
  if (state.viewFilter === 'diverged') return all.some(l => l.status?.ahead > 0 || l.status?.behind > 0);
  return true;
}

function statusPills(local) {
  const status = local.status;
  const syncing = (state.busy.has(`${local.id}:sync`) || state.busy.has(`${local.id}:fetch`)) &&
    h('span', { class: 'pill', title: 'fetching' }, h('span', { class: 'spinner small' }));
  if (!status) return [syncing, h('span', { class: 'pill pending', title: 'Reading status…' }, '···')];
  if (status.error) return [syncing, h('span', { class: 'pill error', title: status.error }, 'error')];
  return [
    syncing,
    h('span', {
      class: 'pill',
      title: `${status.upstream ? `tracking ${status.upstream}` : 'no upstream'}; ↑/↓ as of the last fetch (${fetchedText(status)})`
    }, status.branch || 'detached'),
    status.upstreamGone && h('span', { class: 'pill behind', title: `${status.upstream} no longer exists on the remote` }, 'upstream gone'),
    status.ahead > 0 && h('span', { class: 'pill ahead', title: 'commits to push' }, `↑${status.ahead}`),
    status.behind > 0 && h('span', { class: 'pill behind', title: 'commits to pull' }, `↓${status.behind}`),
    status.conflicted > 0 && h('span', { class: 'pill conflict' }, `${status.conflicted} conflict`),
    status.changes > 0
      ? h('span', { class: 'pill dirty', title: 'uncommitted changes' }, `● ${status.changes}`)
      : h('span', { class: 'pill clean', title: 'working tree clean' }, '✓')
  ];
}

/**
 * Pull and Push for a list row. Buttons that can't do anything are disabled, with the
 * reason in their tooltip.
 */
function rowActions(local) {
  const stop = fn => event => { event.stopPropagation(); fn(); };
  const choice = remoteChoice(local.id);
  const pullTitle = PULL_MODES.find(([mode]) => mode === state.pullMode)[1];
  const status = local.status;
  const busy = repoBusy(local.id);

  let blocked = null; // Why neither button can work
  if (!local.remoteUrl) blocked = 'No remote configured';
  else if (status?.error) blocked = status.error;
  else if (status && !status.branch) blocked = 'Detached HEAD: switch to a branch first';

  let pullBlocked = null;
  if (!blocked && status?.upstreamGone && !choice.pull) {
    pullBlocked = `${status.upstream} no longer exists on the remote. Push to recreate it, or switch branches.`;
  }

  let pushLabel = 'Push';
  let pushTitle = choice.push ? `git push ${choice.push}` : 'git push';
  let nothingToPush = false;
  if (!blocked && status && !choice.push) {
    if (status.upstreamGone) {
      pushTitle = `Push ${status.branch} to recreate ${status.upstream}`;
    } else if (!status.upstream) {
      pushLabel = 'Publish';
      pushTitle = `Push ${status.branch} and track it (no upstream yet)`;
    } else if (status.ahead === 0) {
      nothingToPush = true;
      pushTitle = `Nothing to push: ${status.branch} has no commits that ${status.upstream} lacks`;
    }
  }

  return [
    h('button', {
      class: 'btn small',
      title: blocked || pullBlocked || (choice.pull ? `${pullTitle} from ${choice.pull}` : pullTitle),
      disabled: busy || Boolean(blocked || pullBlocked),
      onclick: stop(() => runAction(local.id, 'pull', { mode: state.pullMode, ...remoteBody(choice.pull) }, { fromList: true }))
    }, busyLabel(`${local.id}:pull`, 'Pull')),
    h('button', {
      class: 'btn small',
      title: blocked || pushTitle,
      disabled: busy || Boolean(blocked) || nothingToPush,
      onclick: stop(() => runAction(local.id, 'push', remoteBody(choice.push), { fromList: true }))
    }, busyLabel(`${local.id}:push`, pushLabel))
  ];
}

function localRow(local, title, { worktree = false } = {}) {
  return h('div', {
    class: `repo-row${worktree ? ' worktree' : ''}${state.selectedId === local.id ? ' selected' : ''}`,
    'data-id': local.id,
    onclick: () => selectRepo(local.id)
  },
    h('div', { class: 'repo-main' },
      h('div', { class: 'repo-name' }, title),
      h('div', { class: 'repo-path' }, local.relPath)
    ),
    h('div', { class: 'repo-meta' }, statusPills(local)),
    h('div', { class: 'repo-actions' }, rowActions(local))
  );
}

function localRows(local, title) {
  return [
    localRow(local, title),
    local.worktrees.map(wt => localRow(wt, wt.name, { worktree: true }))
  ];
}

/**
 * Update one row's status and buttons in place, leaving the rest of the list alone
 */
function patchRow(id) {
  const el = document.querySelector(`.repo-row[data-id="${id}"]`);
  const local = findLocal(id);
  if (!el || !local) return;
  el.querySelector('.repo-meta').replaceChildren(...nodes(statusPills(local)));
  el.querySelector('.repo-actions').replaceChildren(...nodes(rowActions(local)));
}

function markSelectedRow() {
  document.querySelectorAll('.repo-row.selected').forEach(el => el.classList.remove('selected'));
  if (state.selectedId) {
    document.querySelector(`.repo-row[data-id="${state.selectedId}"]`)?.classList.add('selected');
  }
}

/**
 * Match local clones to account repositories. Until GitHub answers, every local
 * repository is listed in one section.
 */
function syncView() {
  const locals = state.locals || [];
  const repos = state.account?.repos;
  if (!repos) return { matched: [], localOnly: locals, notCloned: [] };

  const accountNames = new Set(repos.map(r => r.fullName.toLowerCase()));
  const localsByName = new Map();
  const localOnly = [];
  for (const local of locals) {
    if (local.fullName && accountNames.has(local.fullName)) {
      if (!localsByName.has(local.fullName)) localsByName.set(local.fullName, []);
      localsByName.get(local.fullName).push(local);
    } else {
      localOnly.push(local);
    }
  }

  const matched = [];
  const notCloned = [];
  for (const repo of repos) {
    const matches = localsByName.get(repo.fullName.toLowerCase());
    if (matches) matched.push({ ...repo, locals: matches });
    else notCloned.push(repo);
  }
  return { matched, localOnly, notCloned };
}

function renderSyncProgress() {
  const el = document.getElementById('sync-status');
  const progress = state.syncProgress;
  el.hidden = !progress;
  if (!progress) return;
  el.replaceChildren(h('span', { class: 'spinner small' }), ' ', progress.total === null
    ? 'Scanning folders…'
    : `Reading status ${progress.done}/${progress.total}`);
}

// Scroll state of log boxes, keyed by the log's state object, so a new log starts at its end
const logScroll = new WeakMap();

/**
 * A log box that stays scrolled to its end, unless the user scrolled up to read it.
 * Scrolling back to the end makes it follow again.
 */
function logBox(source, text, extraClass = '') {
  const el = h('pre', {
    class: `output${extraClass}`,
    onscroll: () => {
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      logScroll.set(source, { follow: atEnd, top: el.scrollTop });
    }
  }, text);
  el.logSource = source;
  return el;
}

/**
 * After a re-render, put each log box back at its end, or where the user left it
 */
function restoreLogScroll(container) {
  container.querySelectorAll('pre.output').forEach(el => {
    if (!el.logSource) return;
    const saved = logScroll.get(el.logSource);
    el.scrollTop = !saved || saved.follow ? el.scrollHeight : saved.top;
  });
}

function renderBulkResult() {
  const el = document.getElementById('bulk-result');
  const bulk = state.bulk;
  el.hidden = !bulk;
  if (!bulk) return;

  const { pulled, current, skipped, failed } = bulk.counts;
  let title;
  if (bulk.running) {
    const counted = bulk.total === null ? '' : ` ${bulk.done}/${bulk.total}`;
    title = `${bulk.kind === 'fetch' ? 'Fetching' : 'Pulling'}${counted}…`;
  } else if (bulk.kind === 'fetch') {
    title = `Fetched ${bulk.done - failed} of ${bulk.total ?? bulk.done} repositories`;
  } else {
    title = `Pulled ${pulled} · up to date ${current} · skipped ${skipped} · failed ${failed}`;
  }
  const lines = !bulk.running && bulk.lines.length === 0 && bulk.kind === 'pull'
    ? ['Everything is up to date.']
    : bulk.lines;

  el.className = `bulk-result${bulk.error ? ' error' : ''}`;
  el.replaceChildren(...nodes([
    h('div', { class: 'block-title' },
      h('span', {}, bulk.running && h('span', { class: 'spinner small' }), bulk.running && ' ', title),
      !bulk.running && h('button', { class: 'btn small', onclick: () => { state.bulk = null; renderBulkResult(); } }, 'Dismiss')
    ),
    bulk.running && progressBar(bulk.done, bulk.total),
    lines.length > 0 && logBox(bulk, lines.join('\n'))
  ]));
  restoreLogScroll(el);
}

function sectionTitle(label, count) {
  return h('div', { class: 'section-title' }, h('span', {}, label), h('span', {}, count));
}

function renderRepoList() {
  const container = document.getElementById('repo-list');
  if (!state.locals) {
    container.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' }), ' Scanning folders…'));
    return;
  }

  const notice = document.getElementById('sync-notice');
  const accountError = state.account?.error;
  notice.hidden = !accountError;
  notice.textContent = accountError ? `GitHub: ${accountError}` : '';

  const view = syncView();
  const matched = view.matched.filter(r => matchesFilter([r.fullName, ...r.locals.map(l => l.relPath)], r.locals));
  const localOnly = view.localOnly.filter(l => matchesFilter([l.name, l.relPath, l.remoteUrl], l));
  const notCloned = state.viewFilter === 'all'
    ? view.notCloned.filter(r => matchesFilter([r.fullName], []))
    : [];
  const none = () => h('div', { class: 'file-none empty' }, 'Nothing here.');
  const sections = [];

  if (!state.account) {
    // GitHub hasn't answered yet: show everything found on disk
    sections.push(h('div', { class: 'section-title' },
      h('span', {}, 'Local repositories ', h('span', { class: 'section-note' }, h('span', { class: 'spinner small' }), ' matching with GitHub…')),
      h('span', {}, localOnly.length)));
    if (localOnly.length === 0) sections.push(none());
    localOnly.forEach(local => sections.push(localRows(local, local.fullName || local.name)));
    container.replaceChildren(...nodes(sections));
    return;
  }

  // Without the account list (GitHub error) nothing can be matched, so skip the empty section
  if (state.account.repos) {
    sections.push(sectionTitle('Cloned', matched.length));
    if (matched.length === 0) sections.push(none());
    for (const repo of matched) {
      repo.locals.forEach(local => sections.push(localRows(local, repo.fullName)));
    }
  }

  if (localOnly.length || state.viewFilter === 'all') {
    sections.push(sectionTitle(state.account.repos ? 'Local only (not in your account)' : 'Local repositories', localOnly.length));
    if (localOnly.length === 0) sections.push(none());
    localOnly.forEach(local => sections.push(localRows(local, local.fullName || local.name)));
  }

  if (state.viewFilter === 'all' && state.account.repos) {
    sections.push(sectionTitle('Not cloned', notCloned.length));
    if (notCloned.length === 0) sections.push(none());
    for (const repo of notCloned) {
      const key = `clone:${repo.fullName}`;
      sections.push(h('div', { class: 'repo-row static' },
        h('div', { class: 'repo-main' },
          h('div', { class: 'repo-name' }, repo.fullName),
          h('div', { class: 'repo-path' }, `→ ${state.scanRoot}/${repo.name}`)
        ),
        h('div', { class: 'repo-meta' }, repo.private && h('span', { class: 'pill private' }, 'private')),
        h('div', { class: 'repo-actions' },
          h('button', { class: 'btn small', disabled: state.busy.has(key), onclick: () => cloneRepo(repo.fullName) }, busyLabel(key, 'Clone'))
        )
      ));
    }
  }

  container.replaceChildren(...nodes(sections));
}

// ---------- rendering: detail panel ----------

const STATUS_NAMES = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', '?': 'untracked' };

function selectFile(path, kind) {
  state.selectedFile = { path, kind, full: false };
  state.diff = null;
  renderDetail();
  loadDiff();
}

function fileItem(file, kind, ...buttons) {
  const selected = state.selectedFile && state.selectedFile.path === file.path && state.selectedFile.kind === kind;
  return h('li', {
    class: `file${selected ? ' selected' : ''}`,
    title: STATUS_NAMES[file.status] || file.status,
    onclick: () => selectFile(file.path, kind)
  },
    h('span', { class: `file-status s-${file.status[0]}` }, file.status),
    h('span', { class: 'file-path' }, file.origPath ? `${file.origPath} → ${file.path}` : file.path),
    buttons
  );
}

function iconButton(label, title, onClick, extraClass = '') {
  return h('button', {
    class: `btn small icon ${extraClass}`,
    title,
    onclick: event => {
      event.stopPropagation();
      onClick();
    }
  }, label);
}

function discardFiles(id, files, untracked) {
  const count = files.length + untracked.length;
  const what = count === 1 ? (files[0] || untracked[0]) : `${count} files`;
  const deleting = untracked.length > 0 ? ' Untracked files will be deleted.' : '';
  if (!confirm(`Discard changes to ${what}? This cannot be undone.${deleting}`)) return;
  runAction(id, 'discard', { files, untracked });
}

// Longer file lists (e.g. an unignored build folder) show this many until "Show all"
const MAX_FILES = 300;

function fileList(files, kind, id) {
  if (files.length === 0) return h('div', { class: 'file-none' }, 'None');
  const hidden = state.showAllFiles.has(kind) ? 0 : Math.max(0, files.length - MAX_FILES);
  const more = hidden > 0 && h('div', { class: 'file-none' },
    `… and ${hidden.toLocaleString()} more. `,
    h('button', { class: 'btn small', onclick: () => { state.showAllFiles.add(kind); renderDetail(); } }, 'Show all'));
  return h('div', {}, fileItems(hidden ? files.slice(0, MAX_FILES) : files, kind, id), more);
}

function fileItems(files, kind, id) {
  return h('ul', { class: 'file-list' }, files.map(file => {
    if (kind === 'staged') {
      return fileItem(file, kind, iconButton('−', 'Unstage', () => runAction(id, 'unstage', { files: [file.path] })));
    }
    const discard = kind === 'untracked'
      ? () => discardFiles(id, [], [file.path])
      : () => discardFiles(id, [file.path], []);
    return fileItem(file, kind,
      iconButton('↺', 'Discard changes', discard, 'danger'),
      iconButton('+', 'Stage', () => runAction(id, 'stage', { files: [file.path] })));
  }));
}

function renderDiff() {
  if (!state.selectedFile) return null;
  const title = h('div', { class: 'block-title' },
    h('span', {}, 'Diff ', h('span', { class: 'count' }, `${state.selectedFile.path} (${state.selectedFile.kind})`)),
    h('button', { class: 'btn small', onclick: () => { closeDiff(); renderDetail(); } }, 'Close')
  );
  if (state.diff === null) {
    return h('div', { class: 'block' }, title, h('div', { class: 'file-none' }, h('span', { class: 'spinner' }), ' Loading diff…'));
  }
  if (!state.diff.trim()) {
    return h('div', { class: 'block' }, title, h('div', { class: 'file-none' }, 'No textual changes (binary file, mode change, or the diff could not be loaded).'));
  }
  const lines = state.diff.replace(/\n$/, '').split('\n').map(line => {
    let cls = '';
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) cls = 'meta';
    else if (line.startsWith('@@')) cls = 'hunk';
    else if (line.startsWith('+')) cls = 'add';
    else if (line.startsWith('-')) cls = 'del';
    return h('span', { class: cls }, line || ' ');
  });
  const info = state.diffInfo;
  const cut = info?.truncated && h('div', { class: 'file-none' },
    `Showing the first ${lines.length.toLocaleString()} of ${info.totalLines.toLocaleString()} lines. `,
    h('button', {
      class: 'btn small',
      onclick: () => {
        state.selectedFile.full = true;
        state.diff = null;
        renderDetail();
        loadDiff();
      }
    }, 'Show all'));
  return h('div', { class: 'block' }, title, cut,
    h('pre', { class: 'diff', 'data-file': `${state.selectedFile.kind}:${state.selectedFile.path}` }, lines));
}

/**
 * Rebuild a container while keeping keyboard focus, text selection and scroll positions
 */
function rebuildPreservingFocus(container, build) {
  const active = document.activeElement;
  const focusId = active && container.contains(active) && active.id ? active.id : null;
  const selection = focusId && typeof active.selectionStart === 'number'
    ? [active.selectionStart, active.selectionEnd]
    : null;
  const scrollTop = container.scrollTop;
  const oldDiff = container.querySelector('.diff');
  const diffScroll = oldDiff && { file: oldDiff.dataset.file, top: oldDiff.scrollTop, left: oldDiff.scrollLeft };

  build();

  container.scrollTop = scrollTop;
  const newDiff = container.querySelector('.diff');
  if (newDiff && diffScroll && newDiff.dataset.file === diffScroll.file) {
    newDiff.scrollTop = diffScroll.top;
    newDiff.scrollLeft = diffScroll.left;
  }
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus({ preventScroll: true });
      if (selection && typeof el.setSelectionRange === 'function') {
        try {
          el.setSelectionRange(...selection);
        } catch {
          // Some input types don't support selection
        }
      }
    }
  }
}

function branchSelect(d) {
  const st = d.status;
  const localNames = new Set(d.branches.local.map(b => b.name));
  // Remote branches without a local branch of the same name; each is listed with its remote
  // so identical names on different remotes stay distinct
  const remoteOnly = d.branches.remote.filter(b => !localNames.has(b.name.replace(/^[^/]+\//, '')));

  return h('select', {
    id: 'branch-select',
    title: 'Switch branch',
    disabled: repoBusy(d.id),
    onchange: event => {
      const value = event.target.value;
      const name = value.slice(value.indexOf(':') + 1);
      runAction(d.id, 'checkout', value.startsWith('remote:') ? { remoteBranch: name } : { branch: name });
    }
  },
    !st.branch && h('option', { value: '', selected: true, disabled: true }, `(detached ${st.oid ? st.oid.slice(0, 7) : ''})`),
    h('optgroup', { label: 'Local' }, d.branches.local.map(b => h('option', { value: `local:${b.name}`, selected: b.current }, b.name))),
    remoteOnly.length > 0 && h('optgroup', { label: 'Remote (creates a tracking branch)' },
      remoteOnly.map(b => h('option', { value: `remote:${b.name}` }, b.name)))
  );
}

function renderDetail() {
  const container = document.getElementById('detail');
  if (!state.selectedId) {
    container.replaceChildren(h('div', { class: 'empty' }, 'Select a repository to see changes, branches and history.'));
    return;
  }
  const d = state.detail;
  if (!d) {
    // Show what the list already knows while the full status loads, or why it couldn't
    const local = findLocal(state.selectedId);
    const id = state.selectedId;
    container.replaceChildren(...nodes([
      local && h('div', { class: 'detail-header' },
        h('h2', {}, local.fullName || local.name),
        h('div', { class: 'repo-path' }, local.path)),
      state.detailError
        ? h('div', { class: 'block' },
          h('div', { class: 'block-title' },
            h('span', {}, "Couldn't read this repository"),
            h('button', { class: 'btn small', onclick: () => { state.detailError = null; renderDetail(); loadDetail(id); } }, 'Retry')),
          logBox(state, state.detailError, ' error'))
        : h('div', { class: 'empty' }, h('span', { class: 'spinner' }), ' Loading…')
    ]));
    return;
  }
  rebuildPreservingFocus(container, () => container.replaceChildren(...nodes(buildDetail(d))));
  restoreLogScroll(container);
  if (state.revealOutput === d.id) {
    state.revealOutput = null;
    container.querySelector('.output-block')?.scrollIntoView({ block: 'nearest' });
  }
}

function buildDetail(d) {
  const id = d.id;
  const st = d.status;
  const changeCount = st.unstaged.length + st.untracked.length;
  const output = state.outputs[id];
  const hasCommits = d.log.length > 0;

  const newBranchInput = h('input', {
    id: 'new-branch',
    placeholder: 'new-branch-name',
    value: state.drafts.branch,
    oninput: event => { state.drafts.branch = event.target.value; }
  });
  const createBranch = async () => {
    const name = state.drafts.branch.trim();
    if (!name) return;
    if (await runAction(id, 'branch', { name })) {
      state.drafts.branch = '';
      renderDetail();
    }
  };
  newBranchInput.addEventListener('keydown', event => { if (event.key === 'Enter') createBranch(); });

  const commit = async () => {
    const message = state.drafts.commit.trim();
    if (!message) {
      toast('Write a commit message first', true);
      return;
    }
    if (state.amend && st.upstream && st.ahead === 0 &&
      !confirm('The last commit is already pushed. After amending you will need to force push. Continue?')) {
      return;
    }
    if (await runAction(id, 'commit', { message, amend: state.amend })) {
      state.drafts.commit = '';
      state.amend = false;
      renderDetail();
    }
  };
  const messageInput = h('textarea', {
    id: 'commit-message',
    placeholder: 'Commit message (Ctrl+Enter to commit)',
    oninput: event => { state.drafts.commit = event.target.value; },
    onkeydown: event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) commit(); }
  });
  messageInput.value = state.drafts.commit;

  const amendToggle = h('label', { class: 'check', title: hasCommits ? 'Replace the last commit' : 'No commits yet' },
    h('input', {
      id: 'amend-toggle',
      type: 'checkbox',
      checked: state.amend,
      disabled: !hasCommits,
      onchange: event => {
        state.amend = event.target.checked;
        if (state.amend && !state.drafts.commit.trim() && d.lastMessage) {
          state.drafts.commit = d.lastMessage;
        }
        renderDetail();
      }
    }),
    ' Amend last commit'
  );

  const actionButton = (action, label, body = {}, extraClass = '') => h('button', {
    class: `btn ${extraClass}`,
    disabled: repoBusy(id),
    onclick: () => runAction(id, action, body)
  }, busyLabel(`${id}:${action}`, label));

  const pullMode = h('select', {
    id: 'pull-mode',
    title: 'How to integrate remote commits (also used by the Pull buttons in the list)',
    onchange: event => setPullMode(event.target.value)
  }, pullModeOptions());

  // With several remotes the pickers choose where pull and push go; with one, git decides
  const pickRemotes = d.remotes.length > 1 && st.branch;
  const pullRemote = pickRemotes ? effectiveRemote(d, 'pull') : null;
  const pushRemote = pickRemotes ? effectiveRemote(d, 'push') : null;
  const pushTarget = pushRemote
    ? d.remoteTracking.branches[pushRemote]
    : st.upstream && { ref: st.upstream, ahead: st.ahead, behind: st.behind };
  const diverged = pushTarget && pushTarget.ahead > 0 && pushTarget.behind > 0;
  const forcePush = diverged && h('button', {
    class: 'btn danger',
    title: `git push --force-with-lease${pushRemote ? ` ${pushRemote}` : ''}`,
    disabled: repoBusy(id),
    onclick: () => {
      if (confirm(`Force push ${st.branch}? This replaces ${pushTarget.behind} commit(s) on ${pushTarget.ref} with your local history.`)) {
        runAction(id, 'push', { force: true, ...remoteBody(pushRemote) });
      }
    }
  }, 'Force push');

  const stashInput = h('input', {
    id: 'stash-message',
    placeholder: 'stash message (optional)',
    value: state.drafts.stash,
    oninput: event => { state.drafts.stash = event.target.value; }
  });
  const stash = async () => {
    if (await runAction(id, 'stash', { message: state.drafts.stash })) {
      state.drafts.stash = '';
      renderDetail();
    }
  };

  return [
    h('div', { class: 'detail-header' },
      h('div', { class: 'block-title' },
        h('h2', {}, d.fullName || d.name, d.isWorktree && h('span', { class: 'pill', style: 'margin-left:8px' }, 'worktree')),
        h('button', { class: 'btn small', title: 'Reload status', onclick: () => loadDetail(id) }, 'Refresh')
      ),
      h('div', { class: 'repo-path' }, d.path),
      d.remoteUrl && h('div', { class: 'repo-path' }, d.remoteUrl)
    ),
    h('div', { class: 'detail-bar' },
      branchSelect(d),
      newBranchInput,
      h('button', { class: 'btn', onclick: createBranch }, 'Create branch')
    ),
    h('div', { class: 'detail-bar' },
      h('span', { class: 'muted', title: 'Ahead/behind are as of the last fetch' },
        !st.upstream ? 'no upstream'
          : st.upstreamGone ? `${st.upstream} (gone from the remote)`
            : `${st.upstream} ↑${st.ahead} ↓${st.behind}`,
        d.remotes.length > 0 && ` · ${fetchedText(findLocal(id)?.status)}`),
      h('div', { class: 'spacer' }),
      actionButton('fetch', 'Fetch'),
      // Each button wraps together with the selectors that configure it
      h('div', { class: 'bar-group' },
        pullMode,
        remoteSelect(d, 'pull'),
        actionButton('pull', 'Pull', { mode: state.pullMode, ...remoteBody(pullRemote) })),
      h('div', { class: 'bar-group' },
        remoteSelect(d, 'push'),
        actionButton('push', 'Push', remoteBody(pushRemote), 'primary'),
        forcePush)
    ),
    // Right under the buttons that produce it, so the result of a pull or push is in view
    output && h('div', { class: 'block output-block' },
      h('div', { class: 'block-title' },
        h('span', {}, 'Output'),
        h('div', { class: 'repo-actions' },
          (output.retry || []).map(choice => h('button', {
            class: 'btn small primary',
            disabled: repoBusy(id),
            onclick: () => runAction(id, choice.action, choice.body)
          }, choice.label)),
          h('button', { class: 'btn small', onclick: () => { delete state.outputs[id]; renderDetail(); } }, 'Clear'))
      ),
      logBox(output, output.text, output.error ? ' error' : '')
    ),
    d.operation && h('div', { class: 'block operation' },
      h('div', { class: 'block-title' },
        h('span', {}, `${d.operation[0].toUpperCase()}${d.operation.slice(1)} in progress`),
        h('div', { class: 'repo-actions' },
          h('button', {
            class: 'btn small danger',
            disabled: repoBusy(id),
            onclick: () => {
              if (confirm(`Abort the ${d.operation} and go back to the state before it started?`)) runAction(id, 'abort');
            }
          }, busyLabel(`${id}:abort`, 'Abort')),
          h('button', {
            class: 'btn small primary',
            disabled: st.conflicted.length > 0 || repoBusy(id),
            title: st.conflicted.length > 0 ? 'Resolve and stage all conflicted files first' : `git ${d.operation} --continue`,
            onclick: () => runAction(id, 'continue')
          }, busyLabel(`${id}:continue`, 'Continue'))
        )
      ),
      h('div', { class: 'muted' }, st.conflicted.length > 0
        ? 'Fix the conflicted files in your editor, mark each one resolved, then press Continue.'
        : 'All conflicts are resolved. Press Continue to finish.')
    ),
    st.conflicted.length > 0 && h('div', { class: 'block' },
      h('div', { class: 'block-title' }, h('span', {}, 'Conflicts', h('span', { class: 'count' }, st.conflicted.length))),
      h('ul', { class: 'file-list' }, st.conflicted.map(file => fileItem(file, 'conflicted',
        h('button', {
          class: 'btn small',
          title: 'Mark as resolved (git add)',
          onclick: event => { event.stopPropagation(); runAction(id, 'stage', { files: [file.path] }); }
        }, 'Resolved')
      )))
    ),
    h('div', { class: 'block' },
      h('div', { class: 'block-title' },
        h('span', {}, 'Staged', h('span', { class: 'count' }, st.staged.length)),
        st.staged.length > 0 && h('button', { class: 'btn small', onclick: () => runAction(id, 'unstage', { all: true }) }, 'Unstage all')
      ),
      fileList(st.staged, 'staged', id)
    ),
    h('div', { class: 'block' },
      h('div', { class: 'block-title' },
        h('span', {}, 'Changes', h('span', { class: 'count' }, changeCount)),
        changeCount > 0 && h('div', { class: 'repo-actions' },
          h('button', {
            class: 'btn small danger',
            onclick: () => {
              if (confirm(`Discard all ${changeCount} unstaged changes? Untracked files will be deleted. This cannot be undone.`)) {
                runAction(id, 'discard', { all: true });
              }
            }
          }, 'Discard all'),
          h('button', { class: 'btn small', onclick: () => runAction(id, 'stage', { all: true }) }, 'Stage all'))
      ),
      changeCount === 0
        ? h('div', { class: 'file-none' }, 'Working tree clean')
        : h('div', {},
          st.unstaged.length > 0 && fileList(st.unstaged, 'unstaged', id),
          st.untracked.length > 0 && fileList(st.untracked, 'untracked', id))
    ),
    h('div', { class: 'block commit-box' },
      messageInput,
      h('div', { class: 'commit-row' },
        h('span', { class: 'muted' }, st.branch ? `Commit to ${st.branch}` : 'Detached HEAD'),
        h('div', { class: 'spacer' }),
        amendToggle,
        h('button', {
          class: 'btn primary',
          disabled: (st.staged.length === 0 && !state.amend) || repoBusy(id),
          onclick: commit
        }, busyLabel(`${id}:commit`, state.amend ? 'Amend' : `Commit${st.staged.length ? ` (${st.staged.length})` : ''}`))
      )
    ),
    renderDiff(),
    h('div', { class: 'block' },
      h('div', { class: 'block-title' },
        h('span', {}, 'Stashes', h('span', { class: 'count' }, d.stashes.length))
      ),
      h('div', { class: 'stash-row' },
        stashInput,
        h('button', {
          class: 'btn small',
          disabled: changeCount + st.staged.length === 0 || repoBusy(id),
          onclick: stash
        }, busyLabel(`${id}:stash`, 'Stash changes'))
      ),
      d.stashes.length > 0 && h('ul', { class: 'log' }, d.stashes.map(s => h('li', {},
        h('span', { class: 'hash' }, s.ref),
        h('span', { class: 'subject', title: s.subject }, s.subject),
        h('span', { class: 'when' }, s.date),
        h('button', { class: 'btn small', onclick: () => runAction(id, 'stash-apply', { ref: s.ref }) }, 'Apply'),
        h('button', { class: 'btn small', onclick: () => runAction(id, 'stash-pop', { ref: s.ref }) }, 'Pop'),
        h('button', {
          class: 'btn small danger',
          onclick: () => { if (confirm(`Drop ${s.ref}? This cannot be undone.`)) runAction(id, 'stash-drop', { ref: s.ref }); }
        }, 'Drop')
      )))
    ),
    remotesBlock(d),
    h('div', { class: 'block' },
      h('div', { class: 'block-title' }, h('span', {}, 'Recent commits')),
      d.log.length === 0
        ? h('div', { class: 'file-none' }, 'No commits yet')
        : h('ul', { class: 'log' }, d.log.map(c => h('li', {},
          h('span', { class: 'hash' }, c.hash),
          h('span', { class: 'subject', title: `${c.subject}\n${c.author}` }, c.subject),
          h('span', { class: 'when' }, c.date)
        )))
    )
  ];
}

/**
 * Rename, change the URL and change the push URL of a remote, as separate git commands.
 * Stops at the first one that fails.
 */
async function saveRemote(id, remote) {
  const edit = state.remoteEdit;
  let name = remote.name;
  const newName = edit.newName.trim();
  if (newName && newName !== name) {
    const choice = remoteChoice(id);
    if (!(await runAction(id, 'remote-rename', { name, newName }))) return;
    // Keep pull/push picks of the renamed remote
    for (const kind of ['pull', 'push']) {
      if (choice[kind] === name) choice[kind] = newName;
    }
    saveRemoteChoice(id, choice);
    name = newName;
    edit.name = newName; // Keep the edit row open while the URLs are saved
  }
  const url = edit.url.trim();
  if (url && url !== remote.fetchUrl) {
    if (!(await runAction(id, 'remote-set-url', { name, url }))) return;
  }
  const pushUrl = edit.pushUrl.trim();
  if (pushUrl !== separatePushUrl(remote)) {
    if (!(await runAction(id, 'remote-set-url', { name, url: pushUrl, push: true }))) return;
  }
  state.remoteEdit = null;
  renderDetail();
}

// `git remote -v` shows the fetch URL as push URL when none is set
function separatePushUrl(remote) {
  return remote.pushUrl && remote.pushUrl !== remote.fetchUrl ? remote.pushUrl : '';
}

/**
 * The remote to pull from or push to: the user's pick, else git's default, else origin
 */
function effectiveRemote(d, kind) {
  const names = d.remotes.map(r => r.name);
  const picked = remoteChoice(d.id)[kind];
  if (picked && names.includes(picked)) return picked;
  const fallback = d.remoteTracking.defaults[kind];
  if (fallback && names.includes(fallback)) return fallback;
  return names.includes('origin') ? 'origin' : names[0] || null;
}

/**
 * Pick the remote for pull or push. Only shown with more than one remote; each option
 * shows how the branch compares to that remote's copy.
 */
function remoteSelect(d, kind) {
  if (d.remotes.length < 2 || !d.status.branch) return null;
  const selected = effectiveRemote(d, kind);
  const fallback = d.remoteTracking.defaults[kind];
  const prefix = kind === 'pull' ? 'from' : 'to';
  const label = name => {
    const branch = d.remoteTracking.branches[name];
    const tag = name === fallback ? ' (default)' : '';
    if (branch) return `${prefix} ${branch.ref} ↑${branch.ahead} ↓${branch.behind}${tag}`;
    return `${prefix} ${name}${kind === 'push' ? ' (new branch)' : ` (no ${d.status.branch})`}${tag}`;
  };
  return h('select', {
    id: `${kind}-remote`,
    title: kind === 'pull' ? 'Remote to pull from' : 'Remote to push to',
    onchange: event => {
      setRemoteChoice(d.id, kind, event.target.value, fallback);
      renderDetail();
    }
  }, d.remotes.map(r => h('option', { value: r.name, selected: r.name === selected }, label(r.name))));
}

function remoteInput(id, placeholder, value, onInput, onEnter) {
  return h('input', {
    id,
    placeholder,
    value,
    list: id.endsWith('url') ? 'remote-url-suggestions' : null,
    autocomplete: 'off',
    spellcheck: 'false',
    oninput: event => onInput(event.target.value),
    onkeydown: event => { if (event.key === 'Enter') onEnter(); }
  });
}

function remoteEditRow(id, remote) {
  const edit = state.remoteEdit;
  const saving = state.busy.has(`${id}:remote-rename`) || state.busy.has(`${id}:remote-set-url`);
  const save = () => saveRemote(id, remote);
  return h('li', { class: 'remote-edit' },
    remoteInput('remote-edit-name', 'name', edit.newName, v => { edit.newName = v; }, save),
    h('div', { class: 'remote-buttons' },
      h('button', { class: 'btn small', onclick: () => { state.remoteEdit = null; renderDetail(); } }, 'Cancel'),
      h('button', { class: 'btn small primary', disabled: repoBusy(id), onclick: save },
        saving ? [h('span', { class: 'spinner' }), ' Save'] : 'Save')
    ),
    remoteInput('remote-edit-url', 'fetch URL', edit.url, v => { edit.url = v; }, save),
    remoteInput('remote-edit-pushurl', 'push URL (same as fetch URL)', edit.pushUrl, v => { edit.pushUrl = v; }, save)
  );
}

function remoteRow(id, remote) {
  const pushUrl = separatePushUrl(remote);
  return h('li', { class: 'remote' },
    h('span', { class: 'hash' }, remote.name),
    h('div', { class: 'remote-urls' },
      h('span', { class: 'subject', title: remote.fetchUrl || '' }, remote.fetchUrl || '(no URL)'),
      pushUrl && h('span', { class: 'subject muted', title: pushUrl }, `push: ${pushUrl}`)
    ),
    h('div', { class: 'remote-buttons' },
      h('button', {
        class: 'btn small',
        title: `git fetch --prune ${remote.name}`,
        disabled: repoBusy(id),
        onclick: () => runAction(id, 'fetch', { remote: remote.name })
      }, 'Fetch'),
      h('button', {
        class: 'btn small',
        onclick: () => {
          state.remoteEdit = { name: remote.name, newName: remote.name, url: remote.fetchUrl || '', pushUrl };
          renderDetail();
        }
      }, 'Edit'),
      h('button', {
        class: 'btn small danger',
        disabled: repoBusy(id),
        onclick: () => {
          if (confirm(`Remove remote ${remote.name}? Its remote-tracking branches and the upstream settings that point to it are removed too.`)) {
            runAction(id, 'remote-remove', { name: remote.name });
          }
        }
      }, 'Remove')
    )
  );
}

function remotesBlock(d) {
  const id = d.id;
  const editing = state.remoteEdit && d.remotes.find(r => r.name === state.remoteEdit.name);
  const add = async () => {
    const name = state.drafts.remoteName.trim();
    const url = state.drafts.remoteUrl.trim();
    if (!name || !url) {
      toast('Enter a name and a URL for the remote', true);
      return;
    }
    if (await runAction(id, 'remote-add', { name, url })) {
      state.drafts.remoteName = '';
      state.drafts.remoteUrl = '';
      renderDetail();
    }
  };
  // Suggest the account's repositories, e.g. to add a fork or the original as a second remote
  const suggestions = (state.account?.repos || []).map(r => h('option', { value: `https://github.com/${r.fullName}.git` }));

  return h('div', { class: 'block' },
    h('div', { class: 'block-title' },
      h('span', {}, 'Remotes', h('span', { class: 'count' }, d.remotes.length))
    ),
    d.remotes.length === 0
      ? h('div', { class: 'file-none' }, 'No remotes. Add one to push and pull.')
      : h('ul', { class: 'log remotes' }, d.remotes.map(r => (editing === r ? remoteEditRow(id, r) : remoteRow(id, r)))),
    h('div', { class: 'stash-row remote-add' },
      remoteInput('remote-name', d.remotes.length === 0 ? 'origin' : 'name', state.drafts.remoteName,
        v => { state.drafts.remoteName = v; }, add),
      remoteInput('remote-url', 'URL', state.drafts.remoteUrl, v => { state.drafts.remoteUrl = v; }, add),
      h('button', {
        class: 'btn small',
        disabled: repoBusy(id),
        onclick: add
      }, busyLabel(`${id}:remote-add`, 'Add remote'))
    ),
    suggestions.length > 0 && h('datalist', { id: 'remote-url-suggestions' }, suggestions)
  );
}

function pullModeOptions() {
  return PULL_MODES.map(([mode, label]) => h('option', { value: mode, selected: mode === state.pullMode }, label));
}

/**
 * One pull mode for every Pull button; the toolbar and the detail panel both pick it
 */
function setPullMode(mode) {
  state.pullMode = mode;
  writeSetting('pullMode', mode);
  document.getElementById('pull-mode-global').value = mode;
  scheduleListRender(); // The list's Pull buttons show the mode in their tooltip
  if (state.detail) renderDetail();
}

function renderToolbar() {
  const bulk = state.bulkRun;
  const progress = bulk && bulk.total !== null ? ` ${bulk.done}/${bulk.total}` : '';
  const buttons = [
    ['btn-rescan', 'rescan', 'Rescan disk'],
    ['btn-refresh-account', 'refresh', 'Reload GitHub'],
    ['btn-fetch-all', 'fetch-all', state.busy.has('fetch-all') ? `Fetching${progress}` : 'Fetch all'],
    ['btn-pull-all', 'pull-all', state.busy.has('pull-all') ? `Pulling${progress}` : 'Pull all']
  ];
  for (const [elementId, key, label] of buttons) {
    const button = document.getElementById(elementId);
    // Fetch all and pull all both move every repository, so only one runs at a time
    button.disabled = state.busy.has(key) ||
      (key.endsWith('-all') && (state.busy.has('fetch-all') || state.busy.has('pull-all')));
    button.replaceChildren(...nodes(busyLabel(key, label)));
  }
}

// ---------- wiring ----------

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`));
    if (tab.dataset.tab === 'collaborators' && !state.collab) loadCollaborators();
  });
});

document.getElementById('filter').addEventListener('input', event => {
  state.filter = event.target.value;
  renderRepoList();
});

document.querySelectorAll('#view-filter .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    state.viewFilter = chip.dataset.filter;
    document.querySelectorAll('#view-filter .chip').forEach(c => c.classList.toggle('active', c === chip));
    renderRepoList();
  });
});

const autoFetchToggle = document.getElementById('auto-fetch');
autoFetchToggle.checked = state.autoFetch;
autoFetchToggle.addEventListener('change', () => {
  state.autoFetch = autoFetchToggle.checked;
  writeSetting('autoFetch', state.autoFetch ? '1' : '0');
  autoFetch({ force: true });
});

const globalPullMode = document.getElementById('pull-mode-global');
globalPullMode.replaceChildren(...pullModeOptions());
globalPullMode.addEventListener('change', event => setPullMode(event.target.value));

document.getElementById('btn-rescan').addEventListener('click', () => withBusy('rescan', () => loadSync({ rescan: true })));
document.getElementById('btn-refresh-account').addEventListener('click', () => withBusy('refresh', () => loadSync({ refresh: true })));
document.getElementById('btn-fetch-all').addEventListener('click', () => runBulk('fetch'));
document.getElementById('btn-pull-all').addEventListener('click', () => runBulk('pull'));
document.getElementById('btn-refresh-collab').addEventListener('click', () => loadCollaborators(true));

// Files change outside the app (editor, terminal), so statuses are refreshed when the user
// comes back after a while. Short trips (a confirm dialog, a quick alt-tab) don't count,
// and only rows whose status actually changed are redrawn.
let awaySince = null;
function markAway() {
  if (awaySince === null) awaySince = Date.now();
}
function refreshOnReturn() {
  if (document.visibilityState !== 'visible') {
    markAway();
    return;
  }
  if (awaySince === null) return;
  const away = Date.now() - awaySince;
  awaySince = null;
  if (away < RETURN_REFRESH_MS || state.busy.size > 0) return;
  loadSync({ quiet: true }).then(() => autoFetch());
  if (state.selectedId) loadDetail(state.selectedId);
}
window.addEventListener('blur', markAway);
window.addEventListener('focus', refreshOnReturn);
document.addEventListener('visibilitychange', refreshOnReturn);

renderToolbar();
renderRepoList();
loadUser();
loadSync({ rescan: true }).then(() => autoFetch({ force: true }));
