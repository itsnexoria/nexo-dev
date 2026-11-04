
// ---------------- Welcome / Recent ----------------
async function refreshRecent() {
  const list = await window.nexo.getRecent();
  const ul = document.getElementById('recent-list');
  const empty = document.getElementById('recent-empty');
  ul!.innerHTML = '';
  if (!list.length) {
    empty!.style.display = 'block';
    return;
  }
  empty!.style.display = 'none';
  for (const p of list) {
    const li = document.createElement('li');
    const name = p.split(/[\\/]/).pop();
    li.innerHTML = `<span><span class="rp-name">${escapeHtml(name)}</span><span class="rp-path">${escapeHtml(p)}</span></span><span class="rp-remove">✕</span>`;
    li.addEventListener('click', (e) => {
      if (e.target!.classList.contains('rp-remove')) return;
      if (openInProgress) return;
      openInProgress = true;
      openProject(p).finally(() => { openInProgress = false; });
    });
    li.querySelector('.rp-remove')!.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.nexo.removeRecent(p);
      refreshRecent();
    });
    ul!.appendChild(li);
  }
}

function escapeHtml(str: any) {
  return String(str).replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]));
}

// ---------------- Project / File tree ----------------
// ---------------- Per-project settings override (.nexo/settings.json) ----------------
// A project can override a subset of the global settings for anyone who
// opens it — useful for e.g. a project that needs word wrap on, or a
// specific font size, without changing your global defaults. It's a plain
// JSON file the user edits themselves (or via the convenience commands
// below); Nexo Dev never writes to it except when explicitly asked to.
const PROJECT_OVERRIDABLE_KEYS = ['fontSize', 'wordWrap', 'minimap', 'bracketGuides', 'theme', 'autoSave', 'autoSaveDelayMs', 'vimMode', 'formatOnSave'];

function projectSettingsPath(folder: any) {
  const sep = folder.includes('\\') ? '\\' : '/';
  return `${folder}${sep}.nexo${sep}settings.json`;
}

async function loadProjectSettingsOverride(folder: any) {
  const res = await window.nexo.readFile(projectSettingsPath(folder));
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.content);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    return null;
  }
}

async function applyProjectSettings(folder: any) {
  // Always start from a clean global baseline — otherwise leftover overrides
  // from a previously-open project would bleed into this one.
  try {
    const globalPrefs = await window.nexo.getPrefs();
    Object.assign(uiState, globalPrefs);
  } catch { /* keep current uiState if this fails */ }

  const overrides = await loadProjectSettingsOverride(folder);
  state.projectSettingsActive = !!overrides;
  if (overrides) {
    for (const key of PROJECT_OVERRIDABLE_KEYS) {
      if (overrides[key] !== undefined) uiState[key] = overrides[key];
    }
  }

  applyTheme(uiState.theme, { skipSave: true });
  applyEditorOptionToBoth({
    fontSize: uiState.fontSize,
    wordWrap: uiState.wordWrap ? 'on' : 'off',
    minimap: { enabled: uiState.minimap, renderCharacters: false, maxColumn: 80 },
    bracketPairColorization: { enabled: uiState.bracketGuides },
    guides: { indentation: uiState.bracketGuides, bracketPairs: uiState.bracketGuides },
  });
  if (uiState.vimMode && !vimModeDisposable) enableVimMode();
  else if (!uiState.vimMode && vimModeDisposable) disableVimMode();
  renderSettingsPage();
}

async function handleOpenProjectSettings() {
  if (!state.projectRoot) { alert('Open a project first.'); return; }
  const settingsPath = projectSettingsPath(state.projectRoot);
  const existing = await window.nexo.readFile(settingsPath);
  if (!existing.ok) {
    const template = JSON.stringify({ wordWrap: false, fontSize: uiState.fontSize }, null, 2) + '\n';
    const writeRes = await window.nexo.writeFile(settingsPath, template);
    if (!writeRes.ok) { alert(`Could not create .nexo/settings.json:\n${writeRes.error}`); return; }
  }
  openFile(settingsPath);
}

async function handleSaveCurrentAsProjectSettings() {
  if (!state.projectRoot) { alert('Open a project first.'); return; }
  const snapshot: any = {};
  for (const key of PROJECT_OVERRIDABLE_KEYS) snapshot[key] = uiState[key];
  const settingsPath = projectSettingsPath(state.projectRoot);
  const res = await window.nexo.writeFile(settingsPath, JSON.stringify(snapshot, null, 2) + '\n');
  if (!res.ok) { alert(`Could not save project settings:\n${res.error}`); return; }
  state.projectSettingsActive = true;
  renderTree();
  renderSettingsPage();
  flashToast('Saved current settings as this project\'s override (.nexo/settings.json)');
}

async function openProject(folder: any, opts: any = {}) {
  state.projectRoot = folder;
  if (!opts.keepRoots) { state.roots = [folder]; state.workspaceFile = null; }
  state.expanded = new Set(opts.keepRoots ? [...state.roots] : [folder]);
  paletteState.filesCache = null;
  // Otherwise, once a project was linted before eslint existed in its
  // node_modules (or before `npm install` had been run at all), reopening it
  // later in the same session would stay silently unlinted forever even
  // though the binary is there now.
  noEslintProjects.delete(folder);
  noPyLintProjects.delete(folder);
  pyState.info = null; pyState.selected = null;
  setTimeout(refreshPyStatus, 0);
  await applyProjectSettings(folder);
  document.getElementById('project-name')!.textContent = folder.split(/[\\/]/).pop();
  document.getElementById('sidebar-root-name')!.textContent = folder.split(/[\\/]/).pop().toUpperCase();
  document.getElementById('welcome')!.style.display = 'none';
  document.getElementById('editor-container')!.style.display = 'block';
  await renderTree();

  // Reset search + auto-detect a git repo for the newly opened project
  // (walks up to find .git even if this folder is a subdirectory of a repo)
  document.getElementById('search-input')!.value = '';
  document.getElementById('search-summary')!.textContent = '';
  document.getElementById('search-results')!.innerHTML = '';
  gitState.activePath = null;
  gitState.activeCommit = null;
  refreshGitStatus();
  const termCwd = document.getElementById('terminal-cwd');
  if (termCwd) termCwd.textContent = `— ${state.projectRoot}`;
  updateDiscordPresence();

  // Crash recovery: if nothing's open yet (fresh launch, or first time this
  // project is opened this session), silently reopen whatever was open last
  // time — sessions are saved continuously as tabs change, not just on a
  // clean exit, specifically so a crash/force-close still leaves something
  // to restore from.
  if (!state.openTabs.length) {
    const session = await window.nexo.loadSession(folder);
    if (session && session.openTabs && session.openTabs.length) {
      for (const t of session.openTabs) {
        const exists = await window.nexo.exists(t.path);
        if (!exists) continue;
        await openFile(t.path);
        const tab = state.openTabs.find((x) => x.path === t.path);
        if (tab) {
          tab.pinned = !!t.pinned;
          if (t.cursor && editor && editor.getModel() === tab.model) {
            editor.setPosition({ lineNumber: t.cursor.line, column: t.cursor.column });
            editor.revealPositionInCenter({ lineNumber: t.cursor.line, column: t.cursor.column });
          } else if (t.cursor) {
            // Not the active tab right now — stash it so activateTab can apply
            // it the moment this tab actually gets focus (it has no live
            // viewState yet since it was never opened this session).
            tab.pendingCursor = t.cursor;
          }
        }
      }
      if (session.activeTab && state.openTabs.some((t) => t.path === session.activeTab)) {
        activateTab(session.activeTab);
      }
      renderTabs();
    }
  }
}

// Switch which workspace folder Git / Scripts / Python / terminal operate on, without closing tabs.
async function setActiveRoot(root: any) {
  if (!root || root === state.projectRoot) return;
  state.projectRoot = root;
  paletteState.filesCache = null;
  noEslintProjects.delete(root);
  noPyLintProjects.delete(root);
  pyState.info = null; pyState.selected = null;
  setTimeout(refreshPyStatus, 0);
  await applyProjectSettings(root);
  const name = root.split(/[\\/]/).pop();
  document.getElementById('project-name')!.textContent = state.roots.length > 1 ? `${name} (+${state.roots.length - 1})` : name;
  document.getElementById('sidebar-root-name')!.textContent = state.roots.length > 1 ? 'WORKSPACE' : name.toUpperCase();
  gitState.activePath = null; gitState.activeCommit = null;
  refreshGitStatus();
  const termCwd = document.getElementById('terminal-cwd');
  if (termCwd) termCwd.textContent = `— ${root}`;
  updateDiscordPresence();
  await renderTree();
}

// ---------------- OS integration: "Open with Nexo Dev" + drag files in from Windows ----------------
// Shared by two entry points: the Explorer right-click "Open with" handler
// (main process forwards the path via IPC) and dropping files/folders onto
// the app window from Windows Explorer.
async function openPathFromOS(targetPath: any) {
  if (!targetPath) return;
  const stat = await window.nexo.statPath(targetPath);
  if (!stat.ok) { alert(`Could not open "${targetPath}":\n${stat.error}`); return; }
  if (stat.isDirectory) {
    await openProject(targetPath);
    return;
  }
  // A single file: open its containing folder as the project (so the tree,
  // git panel, etc. all have context) and jump straight to the file.
  const parent = targetPath.slice(0, Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf('\\')));
  if (state.projectRoot !== parent) await openProject(parent);
  await openFile(targetPath);
}

if (window.nexo.onOpenPath) window.nexo.onOpenPath((p: any) => openPathFromOS(p));

// Electron's default behavior for a file dragged in from the OS is to
// navigate the whole window to it (replacing the app UI!) unless prevented.
// Block that everywhere, then handle real OS file/folder drops ourselves.
// Drops that originate from our own file-tree rows (internal move/reorder)
// don't populate dataTransfer.files, so this only ever fires for OS drops.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  const paths = Array.from(files).map((f) => f.path).filter(Boolean);
  if (!paths.length) return;

  const firstStat = await window.nexo.statPath(paths[0]);
  if (firstStat.ok && firstStat.isDirectory) {
    await openProject(paths[0]);
    return;
  }
  // One or more files: open the first one's folder as the project, then
  // open every dropped file (skipping any directories in a mixed drop).
  const parent = paths[0].slice(0, Math.max(paths[0].lastIndexOf('/'), paths[0].lastIndexOf('\\')));
  if (state.projectRoot !== parent) await openProject(parent);
  for (const p of paths) {
    const s = await window.nexo.statPath(p);
    if (s.ok && !s.isDirectory) await openFile(p);
  }
});

// Guards against the classic "clear then await" race: if renderTree() gets
// triggered twice in close succession (e.g. a fast double-click, or a
// folder-expand click landing while a git-status refresh is also touching
// the tree), the older call's results could land *after* the newer call
// already cleared+rebuilt the container, appending a second copy on top
// instead of replacing it. Building off-DOM and checking a token before the
// final swap means a superseded call just discards its work silently.
let treeRenderToken = 0;
// ---------------- Breadcrumb bar ----------------
function renderBreadcrumb() {
  const bar = document.getElementById('breadcrumb-bar');
  if (!state.activeTab || !state.projectRoot) { bar!.innerHTML = ''; bar!.classList.remove('active'); return; }
  const sep = state.projectRoot.includes('\\') ? '\\' : '/';
  const rel = state.activeTab.startsWith(state.projectRoot) ? state.activeTab.slice(state.projectRoot.length + 1) : state.activeTab;
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const rootName = state.projectRoot.split(/[\\/]/).pop();
  let acc = state.projectRoot;
  const segs = [`<span class="crumb crumb-root" data-path="${escapeHtml(state.projectRoot)}" title="${escapeHtml(state.projectRoot)}">${escapeHtml(rootName)}</span>`];
  for (let i = 0; i < parts.length; i++) {
    acc = acc + sep + parts[i];
    const isLast = i === parts.length - 1;
    segs.push(`<span class="crumb-sep">›</span><span class="crumb${isLast ? ' crumb-file' : ''}" data-path="${escapeHtml(acc)}">${escapeHtml(parts[i])}</span>`);
  }
  bar!.innerHTML = segs.join('');
  bar!.classList.add('active');
  bar!.querySelectorAll('.crumb:not(.crumb-file)').forEach((el) => {
    el.addEventListener('click', () => revealInTree(el.dataset.path));
  });
}

async function revealInTree(folderPath: any) {
  let p = folderPath;
  const toExpand = [];
  while (p && p !== state.projectRoot && p.length > state.projectRoot!.length) {
    toExpand.push(p);
    const parentEnd = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    if (parentEnd <= 0) break;
    p = p.slice(0, parentEnd);
  }
  toExpand.push(state.projectRoot);
  toExpand.forEach((f) => state.expanded.add(f));
  await renderTree();
  const row = document.querySelector(`.tree-row[data-path="${CSS.escape(folderPath)}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

async function renderTree() {
  const myToken = ++treeRenderToken;
  const container = document.getElementById('file-tree');
  if (!state.projectRoot) {
    if (myToken === treeRenderToken) container!.innerHTML = '';
    return;
  }
  visibleRowOrder = [];
  if (state.roots.length > 1) {
    const frag = document.createDocumentFragment();
    for (const root of state.roots) {
      const open = state.expanded.has(root);
      const group = document.createElement('div');
      group.className = 'ws-root';
      const head = document.createElement('div');
      head.className = 'ws-root-row' + (root === state.projectRoot ? ' active-root' : '');
      head.dataset.root = root;
      head.title = root;
      head.innerHTML = `<span class="chevron ${open ? 'open' : ''}">▶</span><span class="ws-root-name">${escapeHtml(root.split(/[\\/]/).pop() || root)}</span>${root === state.projectRoot ? '<span class="ws-root-badge" title="Active root: Git, Scripts, Python and the terminal follow it">active</span>' : ''}<span class="ws-root-remove" title="Remove folder from workspace">✕</span>`;
      head.addEventListener('click', async (e) => {
        if (e.target!.closest('.ws-root-remove')) { window.removeWorkspaceRoot && window.removeWorkspaceRoot(root); return; }
        if (state.expanded.has(root)) state.expanded.delete(root); else state.expanded.add(root);
        if (root !== state.projectRoot) await setActiveRoot(root); else await renderTree();
      });
      group.appendChild(head);
      if (open) group.appendChild(await buildNode(root, true));
      frag.appendChild(group);
    }
    if (myToken !== treeRenderToken) return;
    container!.innerHTML = '';
    container!.appendChild(frag);
    return;
  }
  const rootNode = await buildNode(state.projectRoot, true);
  if (myToken !== treeRenderToken) return; // a newer render started — discard this one
  container!.innerHTML = '';
  container!.appendChild(rootNode);
}

// Workspace roots; always at least the active project root.
function wsRoots() { return state.roots.length ? state.roots : (state.projectRoot ? [state.projectRoot] : []); }
function rootOf(filePath: any) {
  return wsRoots().filter((r) => filePath === r || filePath.startsWith(r + '/') || filePath.startsWith(r + '\\')).sort((a, b) => b.length - a.length)[0] || null;
}

function displayRel(p: any) {
  const r = rootOf(p);
  if (!r) return p;
  const rel = p.slice(r.length + 1);
  return state.roots.length > 1 ? `${r.split(/[\\/]/).pop()}/${rel}` : rel;
}

function isIgnoredEntry(entry: any) {
  if (state.showIgnored || !gitState.ignoredPaths.size) return false;
  const rel = relToGitRoot(entry.path);
  if (rel == null) return false;
  if (gitState.ignoredPaths.has(rel)) return true;
  if (entry.isDirectory && gitState.ignoredPaths.has(rel + '/')) return true;
  return false;
}

async function buildNode(nodePath: any, isRoot = false) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';

  const entries = (await window.nexo.readDir(nodePath)).filter((e: any) => !isIgnoredEntry(e));
  // We only render the row for non-root here; root's children are rendered flat.
  if (isRoot) {
    for (const entry of entries) {
      wrap.appendChild(await renderEntry(entry));
    }
    return wrap;
  }
  return wrap;
}

// Flattened, currently-visible tree order — used for Shift+Click range
// selection, since selection needs to span whatever's actually on screen
// (which folders are expanded) rather than the full recursive tree.
let visibleRowOrder: any = [];

async function renderEntry(entry: any) {
  visibleRowOrder.push(entry.path);
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.path = entry.path;
  row.dataset.isDir = entry.isDirectory;

  const isOpen = state.expanded.has(entry.path);
  const deco = entry.isDirectory ? null : gitDecorationFor(entry.path);
  row.innerHTML = `
    <span class="chevron ${entry.isDirectory ? (isOpen ? 'open' : '') : ''}">${entry.isDirectory ? '▶' : ''}</span>
    <span class="ficon">${fileIcon(entry.name, entry.isDirectory, isOpen)}</span>
    <span class="name">${escapeHtml(entry.name)}</span>
    ${deco ? `<span class="tree-git-badge ${deco.cls}">${deco.letter}</span>` : ''}
  `;

  if (state.activeTab && state.activeTab === entry.path) row.classList.add('active');
  if (state.selectedPaths.has(entry.path)) row.classList.add('multi-selected');

  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    dragSourcePath = entry.path;
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', entry.path);
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    document.querySelectorAll('.tree-row.drag-over').forEach((r) => r.classList.remove('drag-over'));
    document.getElementById('file-tree')!.classList.remove('drag-over-root');
  });

  if (entry.isDirectory) {
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (dragSourcePath && dragSourcePath !== entry.path) row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('drag-over');
      await handleTreeDrop(dragSourcePath, entry.path);
    });
  } else {
    // Files aren't drop targets, but still swallow the event so it doesn't
    // bubble up and get treated as a drop onto the project root.
    row.addEventListener('dragover', (e) => e.stopPropagation());
    row.addEventListener('drop', (e) => e.stopPropagation());
  }

  const holder = document.createElement('div');
  holder.appendChild(row);

  let childrenBox = null;
  if (entry.isDirectory) {
    if (isOpen) {
      childrenBox = document.createElement('div');
      childrenBox.className = 'tree-children';
      const children = (await window.nexo.readDir(entry.path)).filter((e: any) => !isIgnoredEntry(e));
      for (const c of children) childrenBox.appendChild(await renderEntry(c));
      holder.appendChild(childrenBox);
    }
  }

  row.addEventListener('click', async (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (state.selectedPaths.has(entry.path)) state.selectedPaths.delete(entry.path);
      else state.selectedPaths.add(entry.path);
      state.lastSelectedPath = entry.path;
      await renderTree();
      return;
    }
    if (e.shiftKey && state.lastSelectedPath) {
      const fromIdx = visibleRowOrder.indexOf(state.lastSelectedPath);
      const toIdx = visibleRowOrder.indexOf(entry.path);
      if (fromIdx !== -1 && toIdx !== -1) {
        const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
        for (let i = lo; i <= hi; i++) state.selectedPaths.add(visibleRowOrder[i]);
        await renderTree();
        return;
      }
    }
    // Plain click: clear any multi-selection and behave as before.
    if (state.selectedPaths.size) { state.selectedPaths.clear(); renderTree(); }
    state.lastSelectedPath = entry.path;
    if (entry.isDirectory) {
      if (state.expanded.has(entry.path)) state.expanded.delete(entry.path);
      else state.expanded.add(entry.path);
      await renderTree();
    } else {
      openFile(entry.path);
    }
  });

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Right-clicking a selected item keeps the whole multi-selection for a
    // bulk action; right-clicking outside it starts a fresh single selection.
    if (!state.selectedPaths.has(entry.path)) state.selectedPaths.clear();
    state.contextTarget = { path: entry.path, isDirectory: entry.isDirectory };
    showContextMenu(e.clientX, e.clientY, entry.isDirectory);
  });

  return holder;
}

// Right-click on empty sidebar area = actions on project root
document.getElementById('file-tree')!.addEventListener('contextmenu', (e) => {
  if (e.target!.id === 'file-tree') {
    e.preventDefault();
    state.selectedPaths.clear();
    state.contextTarget = { path: state.projectRoot, isDirectory: true };
    showContextMenu(e.clientX, e.clientY, true);
  }
});
document.getElementById('file-tree')!.addEventListener('click', (e) => {
  if (e.target!.id === 'file-tree' && state.selectedPaths.size) {
    state.selectedPaths.clear();
    renderTree();
  }
});

// Dropping onto empty tree space (or the root itself) moves the item to the project root.
const fileTreeEl = document.getElementById('file-tree');
fileTreeEl!.addEventListener('dragover', (e) => {
  if (!state.projectRoot || !dragSourcePath) return;
  e.preventDefault();
  fileTreeEl!.classList.add('drag-over-root');
});
fileTreeEl!.addEventListener('dragleave', (e) => {
  if (e.target === fileTreeEl) fileTreeEl!.classList.remove('drag-over-root');
});
fileTreeEl!.addEventListener('drop', async (e) => {
  e.preventDefault();
  fileTreeEl!.classList.remove('drag-over-root');
  if (!state.projectRoot) return;
  await handleTreeDrop(dragSourcePath, state.projectRoot);
});

async function handleTreeDrop(sourcePath: any, destDir: any) {
  if (!sourcePath || !destDir) return;
  const parentOfSource = sourcePath.slice(0, Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\')));
  if (sourcePath === destDir || parentOfSource === destDir) return; // no-op, already there
  const res = await window.nexo.moveItem(sourcePath, destDir);
  if (!res.ok) { alert(`Could not move item:\n${res.error}`); return; }

  // Keep open tabs pointing at the new location (the moved file itself, or
  // any file that was nested inside a moved folder).
  for (const t of state.openTabs) {
    if (t.path === sourcePath) {
      const wasActive = state.activeTab === t.path;
      if (splitState.tabPath === t.path) splitState.tabPath = res.path;
      t.path = res.path;
      t.name = res.path.split(/[\\/]/).pop();
      if (wasActive) state.activeTab = res.path;
    } else if (t.path.startsWith(sourcePath + '/') || t.path.startsWith(sourcePath + '\\')) {
      const wasActive = state.activeTab === t.path;
      const newPath = res.path + t.path.slice(sourcePath.length);
      if (splitState.tabPath === t.path) splitState.tabPath = newPath;
      t.path = newPath;
      if (wasActive) state.activeTab = t.path;
    }
  }

  state.expanded.add(destDir);
  await renderTree();
  renderTabs();
  if (splitState.visible) updateSplitTabOptions();
}
