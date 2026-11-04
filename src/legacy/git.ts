
// ---------------- Git / Source Control ----------------
const gitState: any = { root: null, staged: [], unstaged: [], conflicts: [], available: false, activePath: null, activeStaged: false, activeCommit: null, subtab: 'changes', ignoredPaths: new Set(), commitMsg: '' };

function relToGitRoot(fullPath: any) {
  if (!gitState.root) return null;
  const rootNorm = gitState.root.replace(/\\/g, '/');
  const full = fullPath.replace(/\\/g, '/');
  if (!full.startsWith(rootNorm)) return null;
  return full.slice(rootNorm.length + 1);
}

function gitDecorationFor(fullPath: any) {
  if (!gitState.available) return null;
  const rel = relToGitRoot(fullPath);
  if (rel == null) return null;
  const entry = gitState.unstaged.find((e: any) => e.path === rel) || gitState.staged.find((e: any) => e.path === rel);
  if (!entry) return null;
  const cls = entry.status === '?' ? 'Q' : (['M', 'A', 'D', 'R', 'U'].includes(entry.status) ? entry.status : 'Q');
  return { letter: gitBadgeChar(entry.status), cls };
}

let gitStatusToken = 0;
async function refreshGitStatus() {
  const myToken = ++gitStatusToken;
  const branchLabel = document.getElementById('git-branch-current');
  const pushBtn = document.getElementById('git-push-btn');
  const pullBtn = document.getElementById('git-pull-btn');
  if (!state.projectRoot) {
    branchLabel!.textContent = '—';
    document.getElementById('git-ahead-behind')!.textContent = '';
    pushBtn!.disabled = true;
    pullBtn!.disabled = true;
    document.getElementById('git-body')!.innerHTML = '<div class="git-empty">Open a folder first.</div>';
    updateGitRailBadge();
    return;
  }
  const res = await window.nexo.gitStatus(state.projectRoot);
  if (myToken !== gitStatusToken) return; // a newer refresh started while this one was in flight — discard
  if (!res.ok) {
    gitState.available = false;
    gitState.ignoredPaths = new Set();
    branchLabel!.textContent = '—';
    document.getElementById('git-ahead-behind')!.textContent = '';
    pushBtn!.disabled = true;
    pullBtn!.disabled = true;
    document.getElementById('git-body')!.innerHTML = `<div class="git-empty">${escapeHtml(res.error || 'Not a git repository.')}</div>`;
    renderTree();
    updateGitRailBadge();
    return;
  }
  gitState.available = true;
  gitState.root = res.root;
  gitState.staged = res.staged;
  gitState.unstaged = res.unstaged;
  gitState.conflicts = res.conflicts || [];
  gitState.branch = res.branch;
  branchLabel!.textContent = `🌿 ${res.branch || '(detached)'}`;
  pushBtn!.disabled = false;
  pullBtn!.disabled = false;
  if (gitState.subtab === 'history') renderGitHistory();
  else renderGitPanel();
  renderTree();
  updateGitRailBadge();
  refreshRemoteStatus();
  refreshIgnoredPaths();
}

async function refreshIgnoredPaths() {
  if (!state.showIgnored) {
    const res = await window.nexo.gitIgnoredPaths(state.projectRoot);
    gitState.ignoredPaths = res.ok ? new Set(res.paths) : new Set();
    if (gitState.ignoredPaths.size) renderTree();
  } else {
    gitState.ignoredPaths = new Set();
  }
}

async function refreshRemoteStatus() {
  const label = document.getElementById('git-ahead-behind');
  const pullBtn = document.getElementById('git-pull-btn');
  if (!gitState.available) { label!.textContent = ''; return; }
  const res = await window.nexo.gitRemoteStatus(state.projectRoot);
  if (!res.ok || !res.hasUpstream) {
    label!.textContent = res.ok ? 'no upstream' : '';
    pullBtn!.disabled = !res.ok;
    return;
  }
  const parts = [];
  if (res.ahead) parts.push(`<span class="ahead">↑${res.ahead}</span>`);
  if (res.behind) parts.push(`<span class="behind">↓${res.behind}</span>`);
  label!.innerHTML = parts.length ? parts.join(' ') : 'up to date';
}

async function gitPushFlow() {
  const btn = document.getElementById('git-push-btn');
  btn!.disabled = true;
  btn!.textContent = '⬆ Pushing…';
  const stillWorkingTimer = setTimeout(() => { btn!.textContent = '⬆ Still working…'; }, 5000);
  try {
    const res = await window.nexo.gitPush(state.projectRoot);
    if (!res.ok) { alert(`Push failed:\n${res.error}`); return; }
    refreshRemoteStatus();
  } finally {
    clearTimeout(stillWorkingTimer);
    btn!.textContent = '⬆ Push';
    btn!.disabled = false;
  }
}

async function gitPullFlow() {
  const btn = document.getElementById('git-pull-btn');
  btn!.disabled = true;
  btn!.textContent = '⬇ Pulling…';
  const stillWorkingTimer = setTimeout(() => { btn!.textContent = '⬇ Still working…'; }, 5000);
  try {
    const res = await window.nexo.gitPull(state.projectRoot);
    if (!res.ok) { alert(`Pull failed:\n${res.error}`); return; }
    await renderTree();
    refreshGitStatus();
  } finally {
    clearTimeout(stillWorkingTimer);
    btn!.textContent = '⬇ Pull';
    btn!.disabled = false;
  }
}

document.getElementById('git-push-btn')!.addEventListener('click', gitPushFlow);
document.getElementById('git-pull-btn')!.addEventListener('click', gitPullFlow);

function updateGitRailBadge() {
  const badge = document.getElementById('rail-git-badge');
  if (!badge) return;
  // De-dupe: a file that's both staged and unstaged (partially staged) should
  // only count once, same as VS Code's changed-file count.
  const paths = new Set([...gitState.staged.map((e: any) => e.path), ...gitState.unstaged.map((e: any) => e.path), ...gitState.conflicts.map((e: any) => e.path)]);
  const count = gitState.available ? paths.size : 0;
  badge.textContent = gitState.conflicts.length ? '!' : (count > 99 ? '99+' : String(count));
  badge.classList.toggle('hidden', count === 0);
  badge.classList.toggle('conflict', gitState.conflicts.length > 0);
  document.getElementById('rail-git')!.title = gitState.available
    ? `Source Control (Ctrl+Shift+G) — ${gitState.conflicts.length ? `${gitState.conflicts.length} conflict${gitState.conflicts.length === 1 ? '' : 's'}, ` : ''}${count} change${count === 1 ? '' : 's'} on ${gitState.branch || 'detached HEAD'}`
    : 'Source Control (Ctrl+Shift+G)';
}

function renderGitPanel() {
  gitState.subtab = 'changes';
  document.getElementById('git-tab-changes')!.classList.add('active');
  document.getElementById('git-tab-history')!.classList.remove('active');

  const body = document.getElementById('git-body');
  body!.innerHTML = '';

  if (!gitState.available) {
    body!.innerHTML = '<div class="git-empty">Not a git repository.</div>';
    return;
  }

  if (!gitState.staged.length && !gitState.unstaged.length && !gitState.conflicts.length) {
    const empty = document.createElement('div');
    empty.className = 'git-empty';
    empty.textContent = 'No changes — working tree clean.';
    body!.appendChild(empty);
  } else {
    if (gitState.conflicts.length) {
      const t = document.createElement('div');
      t.className = 'git-section-title conflict-title';
      t.textContent = `MERGE CONFLICTS (${gitState.conflicts.length})`;
      body!.appendChild(t);
      for (const entry of gitState.conflicts) body!.appendChild(renderConflictRow(entry));
    }
    if (gitState.staged.length) {
      const t = document.createElement('div');
      t.className = 'git-section-title';
      t.innerHTML = `<span>STAGED CHANGES (${gitState.staged.length})</span>`;
      const unstageAllBtn = document.createElement('button');
      unstageAllBtn.className = 'git-section-action';
      unstageAllBtn.textContent = 'Unstage All';
      unstageAllBtn.addEventListener('click', async () => {
        const res = await window.nexo.gitUnstageAll(state.projectRoot);
        if (!res.ok) alert(`Could not unstage all:\n${res.error || 'unknown error'}`);
        refreshGitStatus();
      });
      t.appendChild(unstageAllBtn);
      body!.appendChild(t);
      for (const entry of gitState.staged) body!.appendChild(renderGitFileRow(entry, true));
    }
    if (gitState.unstaged.length) {
      const t = document.createElement('div');
      t.className = 'git-section-title';
      t.innerHTML = `<span>CHANGES (${gitState.unstaged.length})</span>`;
      const stageAllBtn = document.createElement('button');
      stageAllBtn.className = 'git-section-action';
      stageAllBtn.textContent = 'Stage All';
      stageAllBtn.addEventListener('click', async () => {
        const res = await window.nexo.gitStageAll(state.projectRoot);
        if (!res.ok) alert(`Could not stage all:\n${res.error || 'unknown error'}`);
        refreshGitStatus();
      });
      t.appendChild(stageAllBtn);
      body!.appendChild(t);
      for (const entry of gitState.unstaged) body!.appendChild(renderGitFileRow(entry, false));
    }
  }

  const commitBox = document.createElement('div');
  commitBox.id = 'git-commit-box';
  commitBox.innerHTML = `
    <textarea id="git-commit-msg" placeholder="Commit message…">${escapeHtml(gitState.commitMsg)}</textarea>
    <button id="git-commit-btn" ${gitState.staged.length ? '' : 'disabled title="Stage at least one file to enable committing"'}>Commit ${gitState.staged.length ? `(${gitState.staged.length})` : ''}</button>
  `;
  body!.appendChild(commitBox);
  const msgBox = document.getElementById('git-commit-msg');
  // Every stage/unstage/refresh rebuilds this whole panel (and with it a
  // fresh textarea), so without stashing the in-progress draft in gitState
  // and restoring it above, ticking a checkbox mid-message would silently
  // wipe out whatever the user had already typed.
  msgBox!.addEventListener('input', () => { gitState.commitMsg = msgBox!.value; });
  document.getElementById('git-commit-btn')!.addEventListener('click', async () => {
    const msg = msgBox!.value.trim();
    if (!msg) { msgBox!.focus(); msgBox!.classList.add('shake'); setTimeout(() => msgBox!.classList.remove('shake'), 400); return; }
    const res = await window.nexo.gitCommit(state.projectRoot, msg);
    if (!res.ok) { alert(`Commit failed:\n${res.error}`); return; }
    gitState.commitMsg = '';
    hideDiff();
    refreshGitStatus();
  });
}

async function renderGitHistory() {
  gitState.subtab = 'history';
  document.getElementById('git-tab-history')!.classList.add('active');
  document.getElementById('git-tab-changes')!.classList.remove('active');

  const body = document.getElementById('git-body');
  if (!gitState.available) { body!.innerHTML = '<div class="git-empty">Not a git repository.</div>'; return; }
  body!.innerHTML = '<div class="git-empty">Loading history…</div>';

  const res = await window.nexo.gitLog(state.projectRoot, 50);
  if (!res.ok) { body!.innerHTML = `<div class="git-empty">${escapeHtml(res.error || 'Could not load history.')}</div>`; return; }
  if (!res.commits.length) { body!.innerHTML = '<div class="git-empty">No commits yet.</div>'; return; }

  body!.innerHTML = '';
  for (const c of res.commits) {
    const row = document.createElement('div');
    row.className = 'commit-row' + (gitState.activeCommit === c.hash ? ' active' : '');
    row.innerHTML = `
      <div class="commit-subject" title="${escapeHtml(c.subject)}">${escapeHtml(c.subject)}</div>
      <div class="commit-meta"><span class="hash">${escapeHtml(c.short)}</span>${escapeHtml(c.author)} · ${escapeHtml(c.date)}</div>
    `;
    row.addEventListener('click', () => showCommitDiff(c.hash, c.short, c.subject));
    body!.appendChild(row);
  }
}

document.getElementById('git-tab-changes')!.addEventListener('click', renderGitPanel);
document.getElementById('git-tab-history')!.addEventListener('click', renderGitHistory);

// ---------------- Branch switching ----------------
async function openBranchDropdown() {
  const existing = document.getElementById('git-branch-dropdown');
  if (existing) { existing.remove(); return; }
  if (!state.projectRoot) return;

  const dropdown = document.createElement('div');
  dropdown.id = 'git-branch-dropdown';
  dropdown.innerHTML = '<div class="branch-item">Loading…</div>';
  document.getElementById('git-branch-row')!.appendChild(dropdown);

  const res = await window.nexo.gitBranches(state.projectRoot);
  dropdown.innerHTML = '';
  if (!res.ok) {
    dropdown.innerHTML = `<div class="branch-item">${escapeHtml(res.error || 'Could not load branches.')}</div>`;
    return;
  }
  for (const b of res.branches) {
    const item = document.createElement('div');
    item.className = 'branch-item' + (b.current ? ' current' : '');
    item.textContent = (b.current ? '● ' : '') + b.name;
    item.addEventListener('click', async () => {
      if (b.current) { dropdown.remove(); return; }
      const switchRes = await window.nexo.gitCheckoutBranch(state.projectRoot, b.name);
      dropdown.remove();
      if (!switchRes.ok) { alert(`Could not switch branch:\n${switchRes.error}`); return; }
      await renderTree();
      refreshGitStatus();
    });
    dropdown.appendChild(item);
  }
  const newItem = document.createElement('div');
  newItem.className = 'branch-item branch-item-new';
  newItem.textContent = '+ New Branch…';
  newItem.addEventListener('click', () => {
    dropdown.remove();
    showModal({
      title: 'New Branch',
      fields: [{ id: 'name', placeholder: 'branch-name' }],
      onConfirm: async ({ name }: any) => {
        const createRes = await window.nexo.gitCreateBranch(state.projectRoot, name);
        if (!createRes.ok) return createRes.error;
        await renderTree();
        refreshGitStatus();
        return null;
      },
    });
  });
  dropdown.appendChild(newItem);
}

document.getElementById('git-branch-switch-btn')!.addEventListener('click', (e) => {
  e.stopPropagation();
  openBranchDropdown();
});
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('git-branch-dropdown');
  if (dropdown && !dropdown.contains(e.target as Node) && e.target!.id !== 'git-branch-switch-btn') dropdown.remove();
});

document.getElementById('btn-git-refresh')!.addEventListener('click', refreshGitStatus);



function gitBadgeChar(status: any) {
  return ({ M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', '?': 'U' } as Record<string, string>)[status] || status;
}

function renderGitFileRow(entry: any, staged: any) {
  const row = document.createElement('div');
  row.className = 'git-file-row' + (gitState.activePath === entry.path && gitState.activeStaged === staged ? ' active' : '');
  const badgeClass = entry.status === '?' ? 'Q' : (['M', 'A', 'D', 'R', 'U'].includes(entry.status) ? entry.status : 'Q');
  row.innerHTML = `
    <span class="gbadge ${badgeClass}">${gitBadgeChar(entry.status)}</span>
    <span class="gpath" title="${escapeHtml(entry.path)}">${escapeHtml(entry.path)}</span>
    <span class="git-row-actions"></span>
  `;
  const actions = row.querySelector('.git-row-actions');

  if (staged) {
    const unstageBtn = document.createElement('button');
    unstageBtn.className = 'git-row-btn';
    unstageBtn.textContent = '−';
    unstageBtn.title = 'Unstage';
    unstageBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await window.nexo.gitUnstage(state.projectRoot, entry.path);
      if (!res.ok) { alert(`Could not unstage "${entry.path}":\n${res.error || 'unknown error'}`); }
      refreshGitStatus();
    });
    actions!.appendChild(unstageBtn);
  } else {
    const stageBtn = document.createElement('button');
    stageBtn.className = 'git-row-btn';
    stageBtn.textContent = '+';
    stageBtn.title = 'Stage';
    stageBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await window.nexo.gitStage(state.projectRoot, entry.path);
      if (!res.ok) { alert(`Could not stage "${entry.path}":\n${res.error || 'unknown error'}`); }
      refreshGitStatus();
    });
    actions!.appendChild(stageBtn);

    if (entry.status !== '?') {
      const discardBtn = document.createElement('button');
      discardBtn.className = 'git-row-btn';
      discardBtn.textContent = '↺';
      discardBtn.title = 'Discard changes';
      discardBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Discard changes to "${entry.path}"? This cannot be undone.`)) return;
        const res = await window.nexo.gitDiscard(state.projectRoot, entry.path);
        if (!res.ok) { alert(`Could not discard changes to "${entry.path}":\n${res.error || 'unknown error'}`); }
        refreshGitStatus();
      });
      actions!.appendChild(discardBtn);
    }
  }

  row.addEventListener('click', () => showDiff(entry.path, staged));
  return row;
}

function renderConflictRow(entry: any) {
  const row = document.createElement('div');
  row.className = 'git-file-row conflict-row';
  row.innerHTML = `
    <span class="gbadge CONFLICT" title="Merge conflict">!</span>
    <span class="gpath" title="${escapeHtml(entry.path)}">${escapeHtml(entry.path)}</span>
    <span class="git-row-actions"></span>
  `;
  const actions = row.querySelector('.git-row-actions');
  const resolveBtn = document.createElement('button');
  resolveBtn.className = 'git-row-btn';
  resolveBtn.textContent = '✓';
  resolveBtn.title = 'Mark resolved (stages the file)';
  resolveBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const res = await window.nexo.gitStage(state.projectRoot, entry.path);
    if (!res.ok) { alert(`Could not mark "${entry.path}" resolved:\n${res.error || 'unknown error'}`); }
    refreshGitStatus();
  });
  actions!.appendChild(resolveBtn);

  // Opening a conflicted file goes straight to the editor (not a diff) so the
  // conflict-resolution banner can help resolve it inline.
  row.addEventListener('click', () => {
    if (!gitState.root) return;
    openFile(`${gitState.root}/${entry.path}`);
  });
  return row;
}

// ---------------- Diff viewer ----------------
function parseDiffToHtml(diffText: any) {
  if (!diffText || !diffText.trim()) return '<div class="diff-line meta">No differences (file may be new/binary, or changes were already staged elsewhere).</div>';
  const lines = diffText.split('\n');
  let html = '';
  for (const line of lines) {
    let cls = 'meta';
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
    else if (line.startsWith('@@')) cls = 'hunk';
    html += `<div class="diff-line ${cls}">${escapeHtml(line) || '&nbsp;'}</div>`;
  }
  return html;
}

async function showDiff(relPath: any, staged: any) {
  gitState.activePath = relPath;
  gitState.activeStaged = staged;
  gitState.activeCommit = null;
  renderGitPanel();

  document.getElementById('welcome')!.style.display = 'none';
  if (editor) document.getElementById('editor-container')!.style.display = 'none';
  document.getElementById('markdown-preview')!.style.display = 'none';
  document.getElementById('md-preview-btn')!.classList.add('hidden');
  document.getElementById('conflict-banner')!.classList.remove('active');
  document.getElementById('breadcrumb-bar')!.classList.remove('active');

  let diffContainer = document.getElementById('diff-container');
  diffContainer!.style.display = 'block';
  { const nv = document.getElementById('notebook-view'); if (nv) nv.style.display = 'none'; }
  diffContainer!.innerHTML = '<div class="diff-line meta">Loading diff…</div>';
  document.getElementById('status-path')!.textContent = `${relPath} (${staged ? 'staged' : 'working tree'} diff)`;
  document.getElementById('status-lang')!.textContent = '';

  const res = await window.nexo.gitDiff(state.projectRoot, relPath, staged);
  if (!res.ok) {
    diffContainer!.innerHTML = `<div class="diff-line meta">${escapeHtml(res.error || 'Could not load diff.')}</div>`;
    return;
  }
  diffContainer!.innerHTML = `<div class="diff-view">${parseDiffToHtml(res.diff)}</div>`;
}

async function showCommitDiff(hash: any, short: any, subject: any) {
  gitState.activePath = null;
  gitState.activeCommit = hash;
  renderGitHistory();

  document.getElementById('welcome')!.style.display = 'none';
  if (editor) document.getElementById('editor-container')!.style.display = 'none';
  document.getElementById('markdown-preview')!.style.display = 'none';
  document.getElementById('md-preview-btn')!.classList.add('hidden');
  document.getElementById('conflict-banner')!.classList.remove('active');
  document.getElementById('breadcrumb-bar')!.classList.remove('active');

  let diffContainer = document.getElementById('diff-container');
  diffContainer!.style.display = 'block';
  { const nv = document.getElementById('notebook-view'); if (nv) nv.style.display = 'none'; }
  diffContainer!.innerHTML = '<div class="diff-line meta">Loading commit…</div>';
  document.getElementById('status-path')!.textContent = `${short} — ${subject}`;
  document.getElementById('status-lang')!.textContent = '';

  const res = await window.nexo.gitShowCommit(state.projectRoot, hash);
  if (!res.ok) {
    diffContainer!.innerHTML = `<div class="diff-line meta">${escapeHtml(res.error || 'Could not load commit.')}</div>`;
    return;
  }
  diffContainer!.innerHTML = `<div class="diff-view">${parseDiffToHtml(res.diff)}</div>`;
}

function hideDiff() {
  gitState.activePath = null;
  gitState.activeCommit = null;
  const diffContainer = document.getElementById('diff-container');
  if (diffContainer) diffContainer.style.display = 'none';
  if (state.activeTab) {
    document.getElementById('editor-container')!.style.display = 'block';
    activateTab(state.activeTab);
  } else {
    document.getElementById('welcome')!.style.display = 'flex';
  }
}

// ---------------- Merge conflict resolution ----------------
// Scans a model's text for git's standard conflict markers and returns the
// line ranges of each block found, in document order.
function scanConflicts(model: any) {
  if (!model) return [];
  const lines = model.getLinesContent();
  const result = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('<<<<<<<')) {
      const startLine = i + 1; // Monaco lines are 1-indexed
      let sepLine = -1;
      let endLine = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (sepLine === -1 && lines[j] === '=======') sepLine = j + 1;
        else if (sepLine !== -1 && lines[j].startsWith('>>>>>>>')) { endLine = j + 1; break; }
      }
      if (sepLine !== -1 && endLine !== -1) {
        result.push({ startLine, sepLine, endLine });
        i = endLine;
      } else {
        break; // malformed / truncated markers — stop rather than misparse
      }
    }
    i++;
  }
  return result;
}

let conflictDecorations: any = null;
function updateConflictDecorations(conflicts: any) {
  if (!editor) return;
  if (!conflictDecorations) conflictDecorations = editor.createDecorationsCollection([]);
  if (!conflicts || !conflicts.length) { conflictDecorations.set([]); return; }
  const decos = [];
  for (const c of conflicts) {
    decos.push({
      range: new monaco.Range(c.startLine, 1, c.sepLine - 1, 1),
      options: { isWholeLine: true, className: 'conflict-deco-ours', linesDecorationsClassName: 'conflict-deco-ours-gutter' },
    });
    decos.push({
      range: new monaco.Range(c.sepLine, 1, c.endLine, 1),
      options: { isWholeLine: true, className: 'conflict-deco-theirs', linesDecorationsClassName: 'conflict-deco-theirs-gutter' },
    });
  }
  conflictDecorations.set(decos);
}

function updateConflictBanner() {
  const banner = document.getElementById('conflict-banner');
  const container = document.getElementById('editor-container');
  if (!editor || !state.activeTab || document.getElementById('diff-container')!.style.display === 'block') {
    banner!.classList.remove('active');
    container!.classList.remove('push-down');
    updateConflictDecorations([]);
    return;
  }
  const conflicts = scanConflicts(editor.getModel());
  updateConflictDecorations(conflicts);
  if (!conflicts.length) {
    banner!.classList.remove('active');
    container!.classList.remove('push-down');
    return;
  }
  document.getElementById('conflict-count')!.textContent = `⚠ ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} in this file`;
  banner!.classList.add('active');
  container!.classList.add('push-down');
}

// Resolves whichever conflict is nearest at-or-below the cursor (wrapping to
// the first one if the cursor is past the last conflict) — feels like
// "resolve the one I'm looking at" rather than always jumping to the top.
function getConflictNearCursor() {
  if (!editor) return null;
  const conflicts = scanConflicts(editor.getModel());
  if (!conflicts.length) return null;
  const pos = editor.getPosition();
  const line = pos ? pos.lineNumber : 1;
  return conflicts.find((c) => c.startLine >= line) || conflicts[0];
}

function resolveConflictAt(model: any, c: any, mode: any) {
  if (!model || !c) return;
  const lines = model.getLinesContent();
  const oursLines = lines.slice(c.startLine, c.sepLine - 1);
  const theirsLines = lines.slice(c.sepLine, c.endLine - 1);
  const replacement = mode === 'current' ? oursLines : mode === 'incoming' ? theirsLines : [...oursLines, ...theirsLines];

  const eol = model.getEOL();
  const isLastLine = c.endLine >= model.getLineCount();
  const range = isLastLine
    ? new monaco.Range(c.startLine, 1, c.endLine, model.getLineMaxColumn(c.endLine))
    : new monaco.Range(c.startLine, 1, c.endLine + 1, 1);
  const text = isLastLine
    ? replacement.join(eol)
    : replacement.join(eol) + (replacement.length ? eol : '');

  model.applyEdits([{ range, text }]);
  if (editor && editor.getModel() === model) updateConflictBanner();
}

function resolveConflict(mode: any) {
  if (!editor) return;
  const c = getConflictNearCursor();
  if (!c) return;
  resolveConflictAt(editor.getModel(), c, mode);
  editor.focus();
}

function jumpToNextConflict() {
  const c = getConflictNearCursor();
  if (!c || !editor) return;
  editor.revealLineInCenter(c.startLine);
  editor.setPosition({ lineNumber: c.startLine, column: 1 });
  editor.focus();
}

// Inline "Accept Current / Accept Incoming / Accept Both" links directly
// above each conflict block, VS-Code-style — lets you resolve a specific
// conflict in place without moving the cursor to it first and using the
// banner buttons, which only ever act on whichever conflict is nearest the
// cursor. CodeLens auto-refreshes on content change, so lenses disappear as
// each conflict gets resolved with no manual re-scan needed.
function registerConflictCodeLensProvider() {
  monaco.editor.registerCommand('nexo.resolveConflictAt', (accessor: any, model: any, conflict: any, mode: any) => {
    resolveConflictAt(model, conflict, mode);
  });
  const languageIds = [...new Set(Object.values(LANG_MAP))];
  const provider = {
    provideCodeLenses(model: any) {
      const conflicts = scanConflicts(model);
      const lenses = [];
      for (const c of conflicts) {
        const range = new monaco.Range(c.startLine, 1, c.startLine, 1);
        lenses.push({ range, command: { id: 'nexo.resolveConflictAt', title: '✓ Accept Current Change', arguments: [model, c, 'current'] } });
        lenses.push({ range, command: { id: 'nexo.resolveConflictAt', title: '✓ Accept Incoming Change', arguments: [model, c, 'incoming'] } });
        lenses.push({ range, command: { id: 'nexo.resolveConflictAt', title: '✓ Accept Both Changes', arguments: [model, c, 'both'] } });
      }
      return { lenses, dispose: () => {} };
    },
    resolveCodeLens(model: any, codeLens: any) { return codeLens; },
  };
  languageIds.forEach((lang) => monaco.languages.registerCodeLensProvider(lang, provider));
}

document.getElementById('conflict-current')!.addEventListener('click', () => resolveConflict('current'));
document.getElementById('conflict-incoming')!.addEventListener('click', () => resolveConflict('incoming'));
document.getElementById('conflict-both')!.addEventListener('click', () => resolveConflict('both'));
document.getElementById('conflict-next')!.addEventListener('click', jumpToNextConflict);
