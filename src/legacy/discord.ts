
// ---------------- Discord Rich Presence ----------------
// Debounced so rapid tab switches or fast typing don't spam the IPC call —
// only the settled state after a short pause gets sent to Discord.
let discordPresenceTimer: any = null;
function updateDiscordPresence() {
  if (!uiState.discordRpcEnabled) return;
  if (discordPresenceTimer) clearTimeout(discordPresenceTimer);
  discordPresenceTimer = setTimeout(() => {
    let details = 'Idle';
    let presenceState = 'No project open';
    if (state.projectRoot) {
      const projectName = state.projectRoot.split(/[\\/]/).pop();
      presenceState = `In ${projectName}`;
      const tab = state.activeTab && state.openTabs.find((t) => t.path === state.activeTab);
      details = tab ? `Editing ${tab.name}` : 'Browsing files';
    }
    if (window.nexo && window.nexo.setDiscordActivity) {
      window.nexo.setDiscordActivity(details, presenceState);
    }
  }, 600);
}

function activateTab(filePath: any) {
  state.activeTab = filePath;
  if (state.roots.length > 1) { const r = rootOf(filePath); if (r && r !== state.projectRoot) setActiveRoot(r); }
  const tab = state.openTabs.find((t) => t.path === filePath);
  if (!tab) return;
  const diffContainer = document.getElementById('diff-container');
  if (diffContainer) diffContainer.style.display = 'none';
  gitState.activePath = null;
  gitState.activeCommit = null;
  renderTabs();
  renderTree();
  renderBreadcrumb();

  if (tab.isImage) {
    { const nv = document.getElementById('notebook-view'); if (nv) nv.style.display = 'none'; }
    document.getElementById('editor-container')!.style.display = 'none';
    document.getElementById('markdown-preview')!.style.display = 'none';
    document.getElementById('md-preview-btn')!.classList.add('hidden');
    document.getElementById('status-path')!.textContent = filePath;
    document.getElementById('status-lang')!.textContent = 'Image';
    updateEolIndicator(null);
    showImagePreview(tab);
    updateDiscordPresence();
    return;
  }
  document.getElementById('image-preview')!.style.display = 'none';

  editor.setModel(tab.model);
  applyPerfOptionsForFile(tab.byteLength || 0);
  if (tab.viewState) editor.restoreViewState(tab.viewState);
  if (tab.pendingCursor) {
    editor.setPosition({ lineNumber: tab.pendingCursor.line, column: tab.pendingCursor.column });
    editor.revealPositionInCenter({ lineNumber: tab.pendingCursor.line, column: tab.pendingCursor.column });
    delete tab.pendingCursor;
  }
  document.getElementById('status-path')!.textContent = filePath;
  document.getElementById('status-lang')!.textContent = tab.model.getModeId ? tab.model.getModeId() : '';
  updateEolIndicator(tab.model);
  document.getElementById('btn-run-py')!.classList.toggle('hidden', !/\.pyw?$/i.test(filePath));
  document.getElementById('btn-debug-py')!.classList.toggle('hidden', !isDebuggablePath(filePath));

  const nbView = document.getElementById('notebook-view');
  if (nbView) nbView.style.display = 'none';
  const nbUiBtn = document.getElementById('md-nb-ui-btn');
  if (nbUiBtn) nbUiBtn.classList.add('hidden');
  if (isNotebookPath(filePath) && tab.nbMode !== 'json') {
    document.getElementById('editor-container')!.style.display = 'none';
    document.getElementById('markdown-preview')!.style.display = 'none';
    document.getElementById('md-preview-btn')!.classList.add('hidden');
    renderNotebook(tab);
    refreshOutlineIfVisible();
    updateDiscordPresence();
    return;
  }
  if (isNotebookPath(filePath) && nbUiBtn) nbUiBtn.classList.remove('hidden');
  if (tab.isMarkdown && tab.mdMode === 'preview') {
    document.getElementById('editor-container')!.style.display = 'none';
    document.getElementById('md-preview-btn')!.classList.add('hidden');
    renderMarkdownPreview(tab);
  } else {
    document.getElementById('markdown-preview')!.style.display = 'none';
    document.getElementById('editor-container')!.style.display = 'block';
    document.getElementById('md-preview-btn')!.classList.toggle('hidden', !tab.isMarkdown);
    editor.focus();
    updateConflictBanner();
  }
  refreshOutlineIfVisible();
  lintFile(filePath);
  refreshBlameForTab(filePath);
  updateDiscordPresence();
}

let draggedTabPath: any = null;
function renderTabs() {
  const bar = document.getElementById('tabbar');
  bar!.innerHTML = '';
  const ordered = [...state.openTabs].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  for (const tab of ordered) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.path === state.activeTab ? ' active' : '') + (tab.modified ? ' modified' : '') + (tab.pinned ? ' pinned' : '');
    el.draggable = true;
    el.innerHTML = `<span class="tab-pin ${tab.pinned ? 'pinned' : ''}" title="${tab.pinned ? 'Unpin' : 'Pin'} tab">📌</span><span class="dot"></span><span class="name">${escapeHtml(tab.name)}</span><span class="split-open" title="Open in split view">⧉</span><span class="close" title="Close">✕</span>`;
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('close')) { closeTab(tab.path); return; }
      if ((e.target as HTMLElement).classList.contains('split-open')) { openInSplit(tab.path); return; }
      if ((e.target as HTMLElement).classList.contains('tab-pin')) { tab.pinned = !tab.pinned; renderTabs(); return; }
      // save previous view state
      if (editor && state.activeTab) {
        const prev = state.openTabs.find((t) => t.path === state.activeTab);
        if (prev) prev.viewState = editor.saveViewState();
      }
      activateTab(tab.path);
    });
    el.addEventListener('dragstart', () => { draggedTabPath = tab.path; });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('tab-drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('tab-drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('tab-drag-over');
      if (!draggedTabPath || draggedTabPath === tab.path) return;
      const fromIdx = state.openTabs.findIndex((t) => t.path === draggedTabPath);
      const toIdx = state.openTabs.findIndex((t) => t.path === tab.path);
      if (fromIdx === -1 || toIdx === -1) return;
      const [moved] = state.openTabs.splice(fromIdx, 1);
      state.openTabs.splice(toIdx, 0, moved);
      draggedTabPath = null;
      renderTabs();
    });
    el.addEventListener('dragend', () => {
      draggedTabPath = null;
      document.querySelectorAll('.tab-drag-over').forEach((t) => t.classList.remove('tab-drag-over'));
    });
    bar!.appendChild(el);
  }
  saveSessionDebounced();
}

function captureTabCursor(tab: any) {
  if (state.activeTab === tab.path && editor && editor.getModel() === tab.model) {
    const pos = editor.getPosition();
    return pos ? { line: pos.lineNumber, column: pos.column } : null;
  }
  const cs = tab.viewState && tab.viewState.cursorState;
  if (cs && cs[0] && cs[0].position) {
    return { line: cs[0].position.lineNumber, column: cs[0].position.column };
  }
  return null;
}

let sessionSaveTimer: any = null;
function saveSessionDebounced() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(() => {
    if (!state.projectRoot) return;
    window.nexo.saveSession(state.projectRoot, {
      openTabs: state.openTabs.map((t) => ({ path: t.path, pinned: !!t.pinned, cursor: captureTabCursor(t) })),
      activeTab: state.activeTab,
    });
  }, 500);
}

const closedTabsStack: any = [];
function reopenClosedTab() {
  const p = closedTabsStack.pop();
  if (p) openFile(p);
}

function closeTab(filePath: any) {
  const idx = state.openTabs.findIndex((t) => t.path === filePath);
  if (idx === -1) return;
  const tab = state.openTabs[idx];
  if (tab.modified) {
    const proceed = confirm(`"${tab.name}" has unsaved changes. Close without saving?`);
    if (!proceed) return;
  }

  // If this file is currently shown in the split pane, move the split to
  // another open tab (or close the split entirely) before disposing the model.
  if (splitState.tabPath === filePath) {
    const fallback = state.openTabs.find((t) => t.path !== filePath);
    if (fallback) showInSplit(fallback.path); else hideSplit();
  }

  window.nexo.unwatchFile(filePath);
  if (isNotebookPath(filePath)) window.nexo.nbRestart(filePath);
  closedTabsStack.push(filePath);
  if (closedTabsStack.length > 20) closedTabsStack.shift();

  if (tab.model) tab.model.dispose();
  state.openTabs.splice(idx, 1);
  if (state.activeTab === filePath) {
    const next = state.openTabs[idx] || state.openTabs[idx - 1];
    if (next) activateTab(next.path);
    else {
      state.activeTab = null;
      editor.setModel(null);
      { const nv = document.getElementById('notebook-view'); if (nv) nv.style.display = 'none'; }
      document.getElementById('status-path')!.textContent = 'No file open';
      document.getElementById('btn-run-py')!.classList.add('hidden');
      document.getElementById('btn-debug-py')!.classList.add('hidden');
      document.getElementById('status-lang')!.textContent = '';
      document.getElementById('markdown-preview')!.style.display = 'none';
      document.getElementById('md-preview-btn')!.classList.add('hidden');
      document.getElementById('editor-container')!.style.display = 'block';
      document.getElementById('conflict-banner')!.classList.remove('active');
      document.getElementById('editor-container')!.classList.remove('push-down');
      renderTabs();
      renderBreadcrumb();
      updateDiscordPresence();
    }
  } else {
    renderTabs();
  }
  updateSplitTabOptions();
}
