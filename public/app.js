'use strict';

const PULL_MODES = [
  ['default', 'Pull (git config)'],
  ['ff-only', 'Pull (fast-forward only)'],
  ['rebase', 'Pull (rebase)'],
  ['merge', 'Pull (merge)']
];

const state = {
  sync: null,
  selectedId: null,
  detail: null,
  detailSeq: 0, // Bumped on every detail update so stale responses are ignored
  selectedFile: null, // { path, kind: 'staged' | 'unstaged' | 'untracked' | 'conflicted' }
  diff: null,
  diffSeq: 0,
  output: null, // { text, error }
  bulkResult: null, // { title, lines, error }
  drafts: { commit: '', branch: '', stash: '' },
  amend: false,
  pullMode: readSetting('pullMode', 'default'),
  filter: '',
  viewFilter: 'all',
  busy: new Set(),
  summaryEpoch: 0,
  summaryLog: [], // [{ epoch, summaries }] so a slower /api/sync response can't undo newer summaries
  collabLoaded: false
};

// ---------- helpers ----------

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
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
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

function toast(message, isError = false) {
  const el = h('div', { class: `toast${isError ? ' error' : ''}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), isError ? 8000 : 3500);
}

/**
 * Run an async task while marking `key` busy, so buttons can show a spinner.
 * Only re-renders the detail panel when the key belongs to the selected repository.
 */
async function withBusy(key, fn) {
  if (state.busy.has(key)) return;
  const touchesDetail = () => state.selectedId && key.startsWith(`${state.selectedId}:`);
  state.busy.add(key);
  touchesDetail() ? render() : renderList();
  try {
    return await fn();
  } finally {
    state.busy.delete(key);
    touchesDetail() ? render() : renderList();
  }
}

function busyLabel(key, label) {
  return state.busy.has(key) ? [h('span', { class: 'spinner' }), ' ', label] : label;
}

function firstLine(text) {
  return String(text || '').split('\n')[0];
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

async function loadSync(params = '') {
  const startedEpoch = state.summaryEpoch;
  try {
    state.sync = await api(`/api/sync${params}`);
    // Summaries that arrived while this request was running are newer than its snapshot
    for (const entry of state.summaryLog) {
      if (entry.epoch > startedEpoch) patchSummaries(entry.summaries);
    }
  } catch (error) {
    toast(error.message, true);
  }
  renderList();
}

/**
 * Load the detail for a repository. Responses that arrive after a newer
 * selection or update are dropped.
 */
async function loadDetail(id) {
  const seq = ++state.detailSeq;
  try {
    const detail = await api(`/api/repo/status?id=${encodeURIComponent(id)}`);
    if (seq !== state.detailSeq || id !== state.selectedId) return;
    state.detail = detail;
    await refreshSelectedFileDiff();
  } catch (error) {
    if (seq !== state.detailSeq || id !== state.selectedId) return;
    state.detail = null;
    toast(error.message, true);
  }
  renderDetail();
}

async function selectRepo(id) {
  if (state.selectedId !== id) {
    closeDiff();
    state.output = null;
    state.drafts = { commit: '', branch: '', stash: '' };
    state.amend = false;
    state.detail = null;
  }
  state.selectedId = id;
  render();
  await loadDetail(id);
}

function closeDiff() {
  state.selectedFile = null;
  state.diff = null;
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
    untracked: file.kind === 'untracked' ? '1' : '0'
  });
  try {
    const { diff } = await api(`/api/repo/diff?${params}`);
    if (seq !== state.diffSeq) return;
    state.diff = diff;
  } catch (error) {
    if (seq !== state.diffSeq) return;
    state.diff = '';
    toast(error.message, true);
  }
  renderDetail();
}

/**
 * Update list summaries in place for the given repository ids
 */
function patchSummaries(summaries) {
  if (!state.sync || !summaries) return;
  const visit = local => {
    if (summaries[local.id]) local.status = summaries[local.id];
    (local.worktrees || []).forEach(visit);
  };
  state.sync.matched.forEach(repo => repo.locals.forEach(visit));
  state.sync.localOnly.forEach(visit);
}

function applySummaries(summaries) {
  if (!summaries) return;
  state.summaryEpoch++;
  state.summaryLog.push({ epoch: state.summaryEpoch, summaries });
  state.summaryLog = state.summaryLog.slice(-50);
  patchSummaries(summaries);
}

/**
 * Apply a fresh detail (from an action response) if it belongs to the selected repository
 */
async function applyDetail(id, detail) {
  if (!detail || id !== state.selectedId) return;
  state.detailSeq++; // Invalidate any slower in-flight loadDetail
  state.detail = detail;
  await refreshSelectedFileDiff();
}

/**
 * Run a git action on a repository, then refresh its detail and its list summary
 */
async function runAction(id, action, body = {}) {
  const label = action.replace('-', ' ');
  return withBusy(`${id}:${action}`, async () => {
    try {
      const result = await api(`/api/repo/${action}`, { method: 'POST', body: { id, ...body } });
      applySummaries(result.summaries);
      await applyDetail(id, result.detail);
      if (id === state.selectedId) {
        state.output = result.output ? { text: `$ git ${label}\n${result.output}`, error: false } : null;
      }
      if (['fetch', 'pull', 'push'].includes(action)) {
        toast(`${label} finished`);
      }
      return true;
    } catch (error) {
      applySummaries(error.data?.summaries);
      await applyDetail(id, error.data?.detail);
      if (id === state.selectedId) {
        const details = [error.data?.stdout, error.data?.stderr].filter(Boolean).join('\n').trim();
        const hint = error.message.includes('Hint:') ? `\n\n${error.message.slice(error.message.indexOf('Hint:'))}` : '';
        state.output = { text: `$ git ${label}\n${details || error.message}${details ? hint : ''}`, error: true };
      }
      toast(`${label} failed: ${firstLine(error.message)}`, true);
      return false;
    }
  });
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
      toast(`Clone failed: ${firstLine(error.message)}`, true);
    }
  });
}

async function fetchAll() {
  await withBusy('fetch-all', async () => {
    try {
      const { results } = await api('/api/sync/fetch-all', { method: 'POST' });
      const failed = results.filter(r => !r.ok);
      state.bulkResult = {
        title: `Fetched ${results.length - failed.length} of ${results.length} repositories`,
        lines: failed.map(f => `✗ ${f.relPath}: ${firstLine(f.error)}`),
        error: failed.length > 0
      };
      await loadSync();
      if (state.selectedId) await loadDetail(state.selectedId);
    } catch (error) {
      toast(error.message, true);
    }
  });
}

async function pullAll() {
  await withBusy('pull-all', async () => {
    try {
      const { pulled, skipped, failed } = await api('/api/sync/pull-all', { method: 'POST' });
      state.bulkResult = {
        title: `Pulled ${pulled.length} · skipped ${skipped.length} · failed ${failed.length}`,
        lines: [
          ...pulled.map(p => `✓ ${p.relPath}: ${p.commits} new commit${p.commits === 1 ? '' : 's'}`),
          ...skipped.map(s => `– ${s.relPath}: skipped, ${s.reason}`),
          ...failed.map(f => `✗ ${f.relPath}: ${firstLine(f.error)}`)
        ],
        error: failed.length > 0
      };
      if (pulled.length + skipped.length + failed.length === 0) {
        state.bulkResult.lines = ['Everything is up to date.'];
      }
      await loadSync();
      if (state.selectedId) await loadDetail(state.selectedId);
    } catch (error) {
      toast(error.message, true);
    }
  });
}

async function loadCollaborators(refresh = false) {
  const container = document.getElementById('collab-content');
  container.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' }), ' Loading collaborators… this can take a while for many repositories.'));
  try {
    const { rows, failed } = await api(`/api/collaborators${refresh ? '?refresh=1' : ''}`);
    state.collabLoaded = true;
    const warning = failed.length > 0 && h('div', { class: 'notice' },
      `Couldn't load collaborators for ${failed.length} repositories because GitHub rate-limited the requests. ` +
      `Press Refresh later to retry: ${failed.join(', ')}`);
    if (rows.length === 0) {
      container.replaceChildren(...[warning, h('div', { class: 'empty' }, 'No repositories with other collaborators found.')].filter(Boolean));
      return;
    }
    container.replaceChildren(...[warning, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Repository'), h('th', {}, 'Collaborators'), h('th', {}, 'Owner'))),
      h('tbody', {}, rows.map(row => h('tr', {},
        h('td', {}, h('a', { href: row.url, target: '_blank', rel: 'noopener' }, row.repoName)),
        h('td', {}, row.others),
        h('td', {}, row.owner)
      )))
    )].filter(Boolean));
  } catch (error) {
    container.replaceChildren(h('div', { class: 'empty' }, error.message));
  }
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

function statusPills(status) {
  if (!status) return [];
  if (status.error) return [h('span', { class: 'pill error', title: status.error }, 'error')];
  return [
    h('span', { class: 'pill', title: status.upstream ? `tracking ${status.upstream}` : 'no upstream' }, status.branch || 'detached'),
    status.ahead > 0 && h('span', { class: 'pill ahead', title: 'commits to push' }, `↑${status.ahead}`),
    status.behind > 0 && h('span', { class: 'pill behind', title: 'commits to pull' }, `↓${status.behind}`),
    status.conflicted > 0 && h('span', { class: 'pill conflict' }, `${status.conflicted} conflict`),
    status.changes > 0
      ? h('span', { class: 'pill dirty', title: 'uncommitted changes' }, `● ${status.changes}`)
      : h('span', { class: 'pill clean', title: 'working tree clean' }, '✓')
  ];
}

function localRow(local, title, { worktree = false } = {}) {
  const stop = fn => event => { event.stopPropagation(); fn(); };
  return h('div', {
    class: `repo-row${worktree ? ' worktree' : ''}${state.selectedId === local.id ? ' selected' : ''}`,
    onclick: () => selectRepo(local.id)
  },
    h('div', { class: 'repo-main' },
      h('div', { class: 'repo-name' }, title),
      h('div', { class: 'repo-path' }, local.relPath)
    ),
    h('div', { class: 'repo-meta' }, statusPills(local.status)),
    h('div', { class: 'repo-actions' },
      h('button', {
        class: 'btn small',
        title: PULL_MODES.find(([mode]) => mode === state.pullMode)[1],
        disabled: state.busy.has(`${local.id}:pull`),
        onclick: stop(() => runAction(local.id, 'pull', { mode: state.pullMode }))
      }, busyLabel(`${local.id}:pull`, 'Pull')),
      h('button', { class: 'btn small', title: 'git push', disabled: state.busy.has(`${local.id}:push`), onclick: stop(() => runAction(local.id, 'push')) },
        busyLabel(`${local.id}:push`, 'Push'))
    )
  );
}

function localRows(local, title) {
  return [
    localRow(local, title),
    local.worktrees.map(wt => localRow(wt, wt.name, { worktree: true }))
  ];
}

function renderBulkResult() {
  const el = document.getElementById('bulk-result');
  const result = state.bulkResult;
  el.hidden = !result;
  if (!result) return;
  el.className = `bulk-result${result.error ? ' error' : ''}`;
  el.replaceChildren(
    h('div', { class: 'block-title' },
      h('span', {}, result.title),
      h('button', { class: 'btn small', onclick: () => { state.bulkResult = null; renderBulkResult(); } }, 'Dismiss')
    ),
    result.lines.length > 0 && h('pre', { class: 'output' }, result.lines.join('\n'))
  );
}

function renderRepoList() {
  const container = document.getElementById('repo-list');
  const sync = state.sync;
  if (!sync) {
    container.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' }), ' Scanning…'));
    return;
  }

  const notice = document.getElementById('sync-notice');
  notice.hidden = !sync.accountError;
  notice.textContent = sync.accountError ? `GitHub: ${sync.accountError}` : '';

  const matched = sync.matched.filter(r => matchesFilter([r.fullName, ...r.locals.map(l => l.relPath)], r.locals));
  const localOnly = sync.localOnly.filter(l => matchesFilter([l.name, l.relPath, l.remoteUrl], l));
  const notCloned = state.viewFilter === 'all'
    ? sync.notCloned.filter(r => matchesFilter([r.fullName], []))
    : [];

  const sections = [];

  sections.push(h('div', { class: 'section-title' }, h('span', {}, 'Cloned'), h('span', {}, matched.length)));
  if (matched.length === 0) sections.push(h('div', { class: 'file-none empty' }, 'Nothing here.'));
  for (const repo of matched) {
    repo.locals.forEach(local => sections.push(localRows(local, repo.fullName)));
  }

  if (localOnly.length || state.viewFilter === 'all') {
    sections.push(h('div', { class: 'section-title' }, h('span', {}, 'Local only (not in your account)'), h('span', {}, localOnly.length)));
    if (localOnly.length === 0) sections.push(h('div', { class: 'file-none empty' }, 'Nothing here.'));
    for (const local of localOnly) {
      sections.push(localRows(local, local.fullName || local.name));
    }
  }

  if (state.viewFilter === 'all') {
    sections.push(h('div', { class: 'section-title' }, h('span', {}, 'Not cloned'), h('span', {}, notCloned.length)));
    if (notCloned.length === 0) sections.push(h('div', { class: 'file-none empty' }, 'Nothing here.'));
    for (const repo of notCloned) {
      const key = `clone:${repo.fullName}`;
      sections.push(h('div', { class: 'repo-row static' },
        h('div', { class: 'repo-main' },
          h('div', { class: 'repo-name' }, repo.fullName),
          h('div', { class: 'repo-path' }, `→ ${sync.scanRoot}/${repo.name}`)
        ),
        h('div', { class: 'repo-meta' }, repo.private && h('span', { class: 'pill private' }, 'private')),
        h('div', { class: 'repo-actions' },
          h('button', { class: 'btn small', disabled: state.busy.has(key), onclick: () => cloneRepo(repo.fullName) }, busyLabel(key, 'Clone'))
        )
      ));
    }
  }

  container.replaceChildren(...sections.flat(Infinity));
}

// ---------- rendering: detail panel ----------

const STATUS_NAMES = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', '?': 'untracked' };

function selectFile(path, kind) {
  state.selectedFile = { path, kind };
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

function fileList(files, kind, id) {
  if (files.length === 0) return h('div', { class: 'file-none' }, 'None');
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
  return h('div', { class: 'block' }, title, h('pre', { class: 'diff', 'data-file': `${state.selectedFile.kind}:${state.selectedFile.path}` }, lines));
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
    container.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' }), ' Loading…'));
    return;
  }
  rebuildPreservingFocus(container, () => container.replaceChildren(...buildDetail(d).filter(Boolean)));
}

function buildDetail(d) {
  const id = d.id;
  const st = d.status;
  const changeCount = st.unstaged.length + st.untracked.length;
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
    disabled: state.busy.has(`${id}:${action}`),
    onclick: () => runAction(id, action, body)
  }, busyLabel(`${id}:${action}`, label));

  const pullMode = h('select', {
    id: 'pull-mode',
    title: 'How to integrate remote commits',
    onchange: event => {
      state.pullMode = event.target.value;
      writeSetting('pullMode', state.pullMode);
      renderList();
    }
  }, PULL_MODES.map(([mode, label]) => h('option', { value: mode, selected: mode === state.pullMode }, label)));

  const diverged = st.upstream && st.ahead > 0 && st.behind > 0;
  const forcePush = diverged && h('button', {
    class: 'btn danger',
    title: 'git push --force-with-lease',
    disabled: state.busy.has(`${id}:push`),
    onclick: () => {
      if (confirm(`Force push ${st.branch}? This replaces ${st.behind} commit(s) on ${st.upstream} with your local history.`)) {
        runAction(id, 'push', { force: true });
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
      st.upstream
        ? h('span', { class: 'muted', title: 'upstream' }, `${st.upstream} ↑${st.ahead} ↓${st.behind}`)
        : h('span', { class: 'muted' }, 'no upstream'),
      h('div', { class: 'spacer' }),
      actionButton('fetch', 'Fetch'),
      pullMode,
      actionButton('pull', 'Pull', { mode: state.pullMode }),
      actionButton('push', 'Push', {}, 'primary'),
      forcePush
    ),
    d.operation && h('div', { class: 'block operation' },
      h('div', { class: 'block-title' },
        h('span', {}, `${d.operation[0].toUpperCase()}${d.operation.slice(1)} in progress`),
        h('div', { class: 'repo-actions' },
          h('button', {
            class: 'btn small danger',
            disabled: state.busy.has(`${id}:abort`),
            onclick: () => {
              if (confirm(`Abort the ${d.operation} and go back to the state before it started?`)) runAction(id, 'abort');
            }
          }, busyLabel(`${id}:abort`, 'Abort')),
          h('button', {
            class: 'btn small primary',
            disabled: st.conflicted.length > 0 || state.busy.has(`${id}:continue`),
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
          disabled: (st.staged.length === 0 && !state.amend) || state.busy.has(`${id}:commit`),
          onclick: commit
        }, busyLabel(`${id}:commit`, state.amend ? 'Amend' : `Commit${st.staged.length ? ` (${st.staged.length})` : ''}`))
      )
    ),
    renderDiff(),
    state.output && h('div', { class: 'block' },
      h('div', { class: 'block-title' },
        h('span', {}, 'Output'),
        h('button', { class: 'btn small', onclick: () => { state.output = null; renderDetail(); } }, 'Clear')
      ),
      h('pre', { class: `output${state.output.error ? ' error' : ''}` }, state.output.text)
    ),
    h('div', { class: 'block' },
      h('div', { class: 'block-title' },
        h('span', {}, 'Stashes', h('span', { class: 'count' }, d.stashes.length))
      ),
      h('div', { class: 'stash-row' },
        stashInput,
        h('button', {
          class: 'btn small',
          disabled: changeCount + st.staged.length === 0 || state.busy.has(`${id}:stash`),
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

function renderToolbar() {
  const buttons = [
    ['btn-rescan', 'rescan', 'Rescan disk'],
    ['btn-refresh-account', 'refresh', 'Reload GitHub'],
    ['btn-fetch-all', 'fetch-all', 'Fetch all'],
    ['btn-pull-all', 'pull-all', 'Pull all']
  ];
  for (const [elementId, key, label] of buttons) {
    const button = document.getElementById(elementId);
    button.disabled = state.busy.has(key);
    button.replaceChildren(...[busyLabel(key, label)].flat());
  }
}

function renderList() {
  renderToolbar();
  renderBulkResult();
  renderRepoList();
}

function render() {
  renderList();
  renderDetail();
}

// ---------- wiring ----------

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`));
    if (tab.dataset.tab === 'collaborators' && !state.collabLoaded) loadCollaborators();
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

document.getElementById('btn-rescan').addEventListener('click', () => withBusy('rescan', () => loadSync('?rescan=1')));
document.getElementById('btn-refresh-account').addEventListener('click', () => withBusy('refresh', () => loadSync('?refresh=1')));
document.getElementById('btn-fetch-all').addEventListener('click', fetchAll);
document.getElementById('btn-pull-all').addEventListener('click', pullAll);
document.getElementById('btn-refresh-collab').addEventListener('click', () => loadCollaborators(true));

// Files change outside the app (editor, terminal), so refresh statuses when the user comes back
let lastFocusRefresh = Date.now();
function refreshOnReturn() {
  if (document.visibilityState !== 'visible' || Date.now() - lastFocusRefresh < 3000) return;
  lastFocusRefresh = Date.now();
  loadSync();
  if (state.selectedId) loadDetail(state.selectedId);
}
window.addEventListener('focus', refreshOnReturn);
document.addEventListener('visibilitychange', refreshOnReturn);

loadUser();
loadSync();
