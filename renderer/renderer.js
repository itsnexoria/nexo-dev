/* global monaco, require */

// ---------------- State ----------------
const state = {
  projectRoot: null,
  expanded: new Set(),
  openTabs: [],      // [{path, name, model, viewState, modified, isUntitled}]
  activeTab: null,
  contextTarget: null, // {path, isDirectory} for right-click actions
};

const uiState = {
  theme: 'dark',
  fontSize: 13.5,
  minimap: true,
  wordWrap: false,
  autoSave: false,
  autoSaveDelayMs: 1000,
  defaultSiteInterval: 10,
  customShell: '',
  customTheme: { bg: '#0c0c10', text: '#ececf0', accent: '#ff3b30' },
  customThemes: [],
};
const splitState = { visible: false, tabPath: null, mdMode: null };
let splitEditor = null;
let editor = null;
let dragSourcePath = null;
let monacoLoaded = false;
let monacoReadyPromise = null;

const LANG_MAP = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp',
  php: 'php', sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml',
  xml: 'xml', sql: 'sql', txt: 'plaintext', env: 'plaintext',
};

function langFromName(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return LANG_MAP[ext] || 'plaintext';
}

function fileIcon(name, isDir, open) {
  if (isDir) return open ? '📂' : '📁';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const map = {
    js: '🟨', jsx: '🟨', ts: '🔷', tsx: '🔷', json: '🧩', html: '🌐', css: '🎨',
    md: '📝', py: '🐍', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', svg: '🖼️', gif: '🖼️',
    gitignore: '🚫', lock: '🔒',
  };
  return map[ext] || '📄';
}

// ---------------- Monaco setup ----------------
// Without this, Monaco's language workers (tokenization, JSON/TS validation,
// etc.) fail to spawn under the file:// protocol used by Electron's
// unbundled AMD loader, and everything silently falls back to running
// synchronously on the main thread — which is what was causing the typing
// lag. This is the standard workaround: hand the worker a tiny bootstrap
// script (as a data: URL, since file:// URLs can't be used as worker
// scripts either) that just importScripts() the real worker file.
const VS_BASE = new URL('../node_modules/monaco-editor/min/vs/', window.location.href).href;
window.MonacoEnvironment = {
  getWorkerUrl(_moduleId, _label) {
    const bootstrap = `
      self.MonacoEnvironment = { baseUrl: '${VS_BASE}' };
      importScripts('${VS_BASE}base/worker/workerMain.js');
    `;
    return `data:text/javascript;charset=utf-8,${encodeURIComponent(bootstrap)}`;
  },
};

const THEMES = [
  { id: 'dark', label: 'Nexo Dark', swatch: '#ff3b30', monaco: 'nexo-dark', icon: '🌙' },
  { id: 'light', label: 'Nexo Light', swatch: '#e5342a', monaco: 'nexo-light', icon: '☀️' },
  { id: 'midnight', label: 'Midnight', swatch: '#3b82f6', monaco: 'nexo-midnight', icon: '🌌' },
  { id: 'contrast', label: 'High Contrast', swatch: '#ffcc00', monaco: 'nexo-contrast', icon: '⬛' },
];
function monacoThemeId(themeId) {
  return (THEMES.find((t) => t.id === themeId) || THEMES[0]).monaco;
}
const CUSTOM_THEME_META = { id: 'custom', label: 'Custom', monaco: 'nexo-custom', icon: '🎨' };

// ---------------- Custom theme color math ----------------
// Takes just three user-picked colors (background, text, accent) and derives
// a full palette matching every variable the four built-in themes define —
// so picking a custom theme feels as simple as it should, without asking
// anyone to hand-tune 20 individual colors.
function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const num = parseInt(h, 16) || 0;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function rgbToHex({ r, g, b }) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('');
}
function mixHex(hexA, hexB, weightB) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return rgbToHex({
    r: a.r + (b.r - a.r) * weightB,
    g: a.g + (b.g - a.g) * weightB,
    b: a.b + (b.b - a.b) * weightB,
  });
}
function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const [rs, gs, bs] = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

const CUSTOM_VAR_KEYS = [
  'bg', 'bg-1', 'bg-2', 'bg-3', 'border', 'border-strong', 'text', 'text-dim', 'text-muted',
  'accent-a', 'accent-b', 'chrome-a', 'chrome-b', 'accent', 'danger', 'ok',
  'diff-add-bg', 'diff-add-fg', 'diff-del-bg', 'diff-del-fg', 'active-bg', 'active-fg',
];

function buildCustomThemeVars({ bg, text, accent }) {
  const isLight = relativeLuminance(bg) > 0.5;
  const activeBg = mixHex(bg, accent, 0.18);
  return {
    bg,
    'bg-1': mixHex(bg, text, 0.03),
    'bg-2': mixHex(bg, text, 0.06),
    'bg-3': mixHex(bg, text, 0.10),
    border: mixHex(bg, text, 0.10) + '69',
    'border-strong': mixHex(bg, text, 0.16),
    text,
    'text-dim': mixHex(text, bg, 0.35),
    'text-muted': mixHex(text, bg, 0.55),
    'accent-a': accent,
    'accent-b': mixHex(accent, '#000000', 0.3),
    'chrome-a': text,
    'chrome-b': mixHex(text, bg, 0.4),
    accent,
    danger: isLight ? '#d9364e' : '#f0526b',
    ok: isLight ? '#1f9d63' : '#3ecf8e',
    'diff-add-bg': mixHex(bg, '#22c55e', 0.15),
    'diff-add-fg': isLight ? '#166534' : '#8fdca9',
    'diff-del-bg': mixHex(bg, '#ef4444', 0.15),
    'diff-del-fg': isLight ? '#991b1b' : '#f0a5b3',
    'active-bg': activeBg,
    'active-fg': relativeLuminance(activeBg) > 0.5 ? '#111114' : '#ffffff',
  };
}

function applyCustomThemeVars(vars) {
  for (const key of CUSTOM_VAR_KEYS) document.body.style.setProperty(`--${key}`, vars[key]);
}
function clearCustomThemeVars() {
  for (const key of CUSTOM_VAR_KEYS) document.body.style.removeProperty(`--${key}`);
}
function applyCustomMonacoTheme(vars) {
  if (!window.monaco) return;
  const isLight = relativeLuminance(uiState.customTheme.bg) > 0.5;
  monaco.editor.defineTheme('nexo-custom', {
    base: isLight ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': vars.bg,
      'editor.lineHighlightBackground': vars['bg-2'],
      'editorLineNumber.foreground': vars['text-muted'],
      'editorCursor.foreground': vars['accent-a'],
      'editor.selectionBackground': vars['active-bg'],
    },
  });
  monaco.editor.setTheme('nexo-custom');
}

// Monaco's built-in right-click menu already has Cut/Copy/Paste, but not
// Select All — Ctrl+A works as a shortcut either way, but adding it here
// makes it visible/discoverable in the menu itself too.
function addSelectAllAction(ed) {
  ed.addAction({
    id: 'nexo-select-all',
    label: 'Select All',
    contextMenuGroupId: '9_cutcopypaste',
    contextMenuOrder: 4,
    run: (instance) => {
      const model = instance.getModel();
      if (model) instance.setSelection(model.getFullModelRange());
    },
  });
}

function initMonaco(cb) {
  require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
  require(['vs/editor/editor.main'], () => {
    monaco.editor.defineTheme('nexo-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0c0c10',
        'editor.lineHighlightBackground': '#18181c',
        'editorLineNumber.foreground': '#4a4a5c',
        'editorCursor.foreground': '#ff3b30',
        'editor.selectionBackground': '#2a2a4499',
      },
    });
    monaco.editor.defineTheme('nexo-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#ffffff',
        'editor.lineHighlightBackground': '#f0f0f3',
        'editorLineNumber.foreground': '#a8a8b2',
        'editorCursor.foreground': '#e5342a',
        'editor.selectionBackground': '#fde3e1',
      },
    });
    monaco.editor.defineTheme('nexo-midnight', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0a0e18',
        'editor.lineHighlightBackground': '#131a2b',
        'editorLineNumber.foreground': '#4a5a7c',
        'editorCursor.foreground': '#3b82f6',
        'editor.selectionBackground': '#1e2c5299',
      },
    });
    // Built on Monaco's own high-contrast base theme, which is designed for
    // accessibility (max contrast, distinct token colors) rather than us
    // trying to hand-tune contrast ratios ourselves.
    monaco.editor.defineTheme('nexo-contrast', {
      base: 'hc-black',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#000000',
        'editorCursor.foreground': '#ffcc00',
        'editor.selectionBackground': '#3a2f00',
      },
    });
    // Define the custom theme too, in case that's what was saved — built from
    // whatever custom colors were loaded into uiState just before Monaco started.
    const customVars = buildCustomThemeVars(uiState.customTheme);
    monaco.editor.defineTheme('nexo-custom', {
      base: relativeLuminance(uiState.customTheme.bg) > 0.5 ? 'vs' : 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': customVars.bg,
        'editor.lineHighlightBackground': customVars['bg-2'],
        'editorLineNumber.foreground': customVars['text-muted'],
        'editorCursor.foreground': customVars['accent-a'],
        'editor.selectionBackground': customVars['active-bg'],
      },
    });
    if (uiState.theme === 'custom') applyCustomThemeVars(customVars);
    const monacoTheme = uiState.theme === 'custom' ? 'nexo-custom' : monacoThemeId(uiState.theme);

    editor = monaco.editor.create(document.getElementById('editor-container'), {
      automaticLayout: true,
      fontFamily: "'Cascadia Code', Consolas, 'JetBrains Mono', monospace",
      fontSize: uiState.fontSize,
      theme: monacoTheme,
      model: null,
      // Perf-friendly defaults — these features are the main sources of
      // per-keystroke/scroll cost in Monaco, especially on larger files.
      minimap: { enabled: uiState.minimap, renderCharacters: false, maxColumn: 80 },
      wordWrap: uiState.wordWrap ? 'on' : 'off',
      bracketPairColorization: { enabled: false },
      smoothScrolling: false,
      renderWhitespace: 'selection',
      occurrencesHighlight: 'off',
      wordBasedSuggestions: 'currentDocument',
    });

    editor.onDidChangeCursorPosition((e) => {
      document.getElementById('status-pos').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    });
    addSelectAllAction(editor);

    cb();
  });
}

// Files above this size get minimap + bracket colorization forced off (they're
// already off by default above, but this also disables per-model extras like
// folding, which get expensive on huge files) — keeps big log/data files smooth.
const LARGE_FILE_BYTES = 400 * 1024;
function applyPerfOptionsForFile(byteLength) {
  if (!editor) return;
  const isLarge = byteLength > LARGE_FILE_BYTES;
  editor.updateOptions({
    minimap: { enabled: uiState.minimap && !isLarge, renderCharacters: false, maxColumn: 80 },
    folding: !isLarge,
    links: !isLarge,
  });
}

// ---------------- Welcome / Recent ----------------
async function refreshRecent() {
  const list = await window.nexo.getRecent();
  const ul = document.getElementById('recent-list');
  const empty = document.getElementById('recent-empty');
  ul.innerHTML = '';
  if (!list.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  for (const p of list) {
    const li = document.createElement('li');
    const name = p.split(/[\\/]/).pop();
    li.innerHTML = `<span><span class="rp-name">${escapeHtml(name)}</span><span class="rp-path">${escapeHtml(p)}</span></span><span class="rp-remove">✕</span>`;
    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('rp-remove')) return;
      if (openInProgress) return;
      openInProgress = true;
      openProject(p).finally(() => { openInProgress = false; });
    });
    li.querySelector('.rp-remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.nexo.removeRecent(p);
      refreshRecent();
    });
    ul.appendChild(li);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- Project / File tree ----------------
async function openProject(folder) {
  state.projectRoot = folder;
  state.expanded = new Set([folder]);
  document.getElementById('project-name').textContent = folder.split(/[\\/]/).pop();
  document.getElementById('sidebar-root-name').textContent = folder.split(/[\\/]/).pop().toUpperCase();
  document.getElementById('welcome').style.display = 'none';
  document.getElementById('editor-container').style.display = 'block';
  await renderTree();

  // Reset search + auto-detect a git repo for the newly opened project
  // (walks up to find .git even if this folder is a subdirectory of a repo)
  document.getElementById('search-input').value = '';
  document.getElementById('search-summary').textContent = '';
  document.getElementById('search-results').innerHTML = '';
  gitState.activePath = null;
  gitState.activeCommit = null;
  refreshGitStatus();
  const termCwd = document.getElementById('terminal-cwd');
  if (termCwd) termCwd.textContent = `— ${state.projectRoot}`;
}

// ---------------- OS integration: "Open with Nexo Dev" + drag files in from Windows ----------------
// Shared by two entry points: the Explorer right-click "Open with" handler
// (main process forwards the path via IPC) and dropping files/folders onto
// the app window from Windows Explorer.
async function openPathFromOS(targetPath) {
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

if (window.nexo.onOpenPath) window.nexo.onOpenPath((p) => openPathFromOS(p));

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
async function renderTree() {
  const myToken = ++treeRenderToken;
  const container = document.getElementById('file-tree');
  if (!state.projectRoot) {
    if (myToken === treeRenderToken) container.innerHTML = '';
    return;
  }
  const rootNode = await buildNode(state.projectRoot, true);
  if (myToken !== treeRenderToken) return; // a newer render started — discard this one
  container.innerHTML = '';
  container.appendChild(rootNode);
}

async function buildNode(nodePath, isRoot = false) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';

  const entries = await window.nexo.readDir(nodePath);
  // We only render the row for non-root here; root's children are rendered flat.
  if (isRoot) {
    for (const entry of entries) {
      wrap.appendChild(await renderEntry(entry));
    }
    return wrap;
  }
  return wrap;
}

async function renderEntry(entry) {
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

  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    dragSourcePath = entry.path;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', entry.path);
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    document.querySelectorAll('.tree-row.drag-over').forEach((r) => r.classList.remove('drag-over'));
    document.getElementById('file-tree').classList.remove('drag-over-root');
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
      const children = await window.nexo.readDir(entry.path);
      for (const c of children) childrenBox.appendChild(await renderEntry(c));
      holder.appendChild(childrenBox);
    }
  }

  row.addEventListener('click', async () => {
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
    state.contextTarget = { path: entry.path, isDirectory: entry.isDirectory };
    showContextMenu(e.clientX, e.clientY, entry.isDirectory);
  });

  return holder;
}

// Right-click on empty sidebar area = actions on project root
document.getElementById('file-tree').addEventListener('contextmenu', (e) => {
  if (e.target.id === 'file-tree') {
    e.preventDefault();
    state.contextTarget = { path: state.projectRoot, isDirectory: true };
    showContextMenu(e.clientX, e.clientY, true);
  }
});

// Dropping onto empty tree space (or the root itself) moves the item to the project root.
const fileTreeEl = document.getElementById('file-tree');
fileTreeEl.addEventListener('dragover', (e) => {
  if (!state.projectRoot || !dragSourcePath) return;
  e.preventDefault();
  fileTreeEl.classList.add('drag-over-root');
});
fileTreeEl.addEventListener('dragleave', (e) => {
  if (e.target === fileTreeEl) fileTreeEl.classList.remove('drag-over-root');
});
fileTreeEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  fileTreeEl.classList.remove('drag-over-root');
  if (!state.projectRoot) return;
  await handleTreeDrop(dragSourcePath, state.projectRoot);
});

async function handleTreeDrop(sourcePath, destDir) {
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

// ---------------- Tabs / Editor ----------------
async function openFile(filePath) {
  if (!monacoLoaded) {
    document.getElementById('status-path').textContent = 'Loading editor…';
    await monacoReadyPromise;
  }
  let tab = state.openTabs.find((t) => t.path === filePath);
  if (!tab) {
    const res = await window.nexo.readFile(filePath);
    if (!res.ok) {
      alert(`Could not open file:\n${res.error}`);
      return;
    }
    const name = filePath.split(/[\\/]/).pop();
    const lang = langFromName(name);
    const isMarkdown = /\.(md|markdown)$/i.test(name);
    const model = monaco.editor.createModel(res.content, lang);
    model.onDidChangeContent(() => {
      const t = state.openTabs.find((x) => x.path === filePath);
      if (t && !t.modified) { t.modified = true; renderTabs(); }
      if (editor && editor.getModel() === model) {
        updateConflictBanner();
        if (t && t.isMarkdown && t.mdMode === 'preview') renderMarkdownPreview(t);
        maybeAutoSave(filePath);
      }
      if (t && splitState.visible && splitState.tabPath === filePath && splitState.mdMode === 'preview') {
        renderSplitMarkdownPreview(t);
      }
    });
    tab = { path: filePath, name, model, modified: false, byteLength: res.content.length, isMarkdown, mdMode: isMarkdown ? 'preview' : null };
    state.openTabs.push(tab);
    if (splitState.visible) updateSplitTabOptions();
  }
  activateTab(filePath);
  renderTree();
}

function activateTab(filePath) {
  state.activeTab = filePath;
  const tab = state.openTabs.find((t) => t.path === filePath);
  if (!tab) return;
  const diffContainer = document.getElementById('diff-container');
  if (diffContainer) diffContainer.style.display = 'none';
  gitState.activePath = null;
  gitState.activeCommit = null;
  editor.setModel(tab.model);
  applyPerfOptionsForFile(tab.byteLength || 0);
  if (tab.viewState) editor.restoreViewState(tab.viewState);
  document.getElementById('status-path').textContent = filePath;
  document.getElementById('status-lang').textContent = tab.model.getModeId ? tab.model.getModeId() : '';
  renderTabs();
  renderTree();

  if (tab.isMarkdown && tab.mdMode === 'preview') {
    document.getElementById('editor-container').style.display = 'none';
    document.getElementById('md-preview-btn').classList.add('hidden');
    renderMarkdownPreview(tab);
  } else {
    document.getElementById('markdown-preview').style.display = 'none';
    document.getElementById('editor-container').style.display = 'block';
    document.getElementById('md-preview-btn').classList.toggle('hidden', !tab.isMarkdown);
    editor.focus();
    updateConflictBanner();
  }
}

function renderTabs() {
  const bar = document.getElementById('tabbar');
  bar.innerHTML = '';
  for (const tab of state.openTabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.path === state.activeTab ? ' active' : '') + (tab.modified ? ' modified' : '');
    el.innerHTML = `<span class="dot"></span><span class="name">${escapeHtml(tab.name)}</span><span class="split-open" title="Open in split view">⧉</span><span class="close">✕</span>`;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('close')) { closeTab(tab.path); return; }
      if (e.target.classList.contains('split-open')) { openInSplit(tab.path); return; }
      // save previous view state
      if (editor && state.activeTab) {
        const prev = state.openTabs.find((t) => t.path === state.activeTab);
        if (prev) prev.viewState = editor.saveViewState();
      }
      activateTab(tab.path);
    });
    bar.appendChild(el);
  }
}

function closeTab(filePath) {
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

  tab.model.dispose();
  state.openTabs.splice(idx, 1);
  if (state.activeTab === filePath) {
    const next = state.openTabs[idx] || state.openTabs[idx - 1];
    if (next) activateTab(next.path);
    else {
      state.activeTab = null;
      editor.setModel(null);
      document.getElementById('status-path').textContent = 'No file open';
      document.getElementById('status-lang').textContent = '';
      document.getElementById('markdown-preview').style.display = 'none';
      document.getElementById('md-preview-btn').classList.add('hidden');
      document.getElementById('editor-container').style.display = 'block';
      document.getElementById('conflict-banner').classList.remove('active');
      document.getElementById('editor-container').classList.remove('push-down');
      renderTabs();
    }
  } else {
    renderTabs();
  }
  updateSplitTabOptions();
}

// ---------------- Markdown preview ----------------
function renderMarkdownPreview(tab) {
  const box = document.getElementById('markdown-preview-content');
  try {
    if (window.marked) {
      box.innerHTML = marked.parse(tab.model.getValue());
    } else {
      // Most likely cause: node_modules/marked isn't installed — either the
      // project was set up before "marked" was added to package.json, or
      // node_modules got copied/moved without it. Either way, "npm install"
      // fixes it.
      box.innerHTML = `
        <p><strong>Markdown renderer not available.</strong></p>
        <p>The <code>marked</code> package (used to render previews) doesn't seem to be installed. Run this in the project folder and restart the app:</p>
        <pre><code>npm install</code></pre>
        <p style="color:var(--text-muted)">You can still view/edit the raw source with the "✏️ Edit" button above.</p>
      `;
    }
  } catch (err) {
    box.innerHTML = `<p>Could not render markdown: ${escapeHtml(err.message)}</p>`;
  }
  document.getElementById('markdown-preview').style.display = 'flex';
}

function setMarkdownMode(tab, mode) {
  tab.mdMode = mode;
  if (state.activeTab !== tab.path) return;
  if (mode === 'preview') {
    document.getElementById('editor-container').style.display = 'none';
    document.getElementById('editor-container').classList.remove('push-down');
    document.getElementById('md-preview-btn').classList.add('hidden');
    document.getElementById('conflict-banner').classList.remove('active');
    renderMarkdownPreview(tab);
  } else {
    document.getElementById('markdown-preview').style.display = 'none';
    document.getElementById('editor-container').style.display = 'block';
    document.getElementById('md-preview-btn').classList.remove('hidden');
    editor.focus();
    updateConflictBanner();
  }
}

document.getElementById('md-preview-btn').addEventListener('click', () => {
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (tab) setMarkdownMode(tab, 'preview');
});
document.getElementById('md-edit-btn').addEventListener('click', () => {
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (tab) setMarkdownMode(tab, 'edit');
});
// External links in a rendered preview should open in the system browser —
// there's no in-app page navigation for them to go to.
document.getElementById('markdown-preview-content').addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href') || '';
  if (/^https?:\/\//i.test(href)) window.nexo.openExternal(href);
});

const autoSaveTimers = new Map();
function maybeAutoSave(filePath) {
  if (!uiState.autoSave) return;
  clearTimeout(autoSaveTimers.get(filePath));
  const timer = setTimeout(async () => {
    autoSaveTimers.delete(filePath);
    const tab = state.openTabs.find((t) => t.path === filePath);
    if (!tab || !tab.modified) return;
    const res = await window.nexo.writeFile(tab.path, tab.model.getValue());
    if (res.ok) {
      tab.modified = false;
      renderTabs();
    }
  }, uiState.autoSaveDelayMs);
  autoSaveTimers.set(filePath, timer);
}

async function saveActiveTab() {
  if (!state.activeTab) return;
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (!tab) return;
  const res = await window.nexo.writeFile(tab.path, tab.model.getValue());
  if (!res.ok) { alert(`Could not save file:\n${res.error}`); return; }
  tab.modified = false;
  renderTabs();
}

async function saveActiveTabAs() {
  if (!state.activeTab) return;
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (!tab) return;
  const newPath = await window.nexo.saveAsDialog(tab.name);
  if (!newPath) return;
  const res = await window.nexo.writeFile(newPath, tab.model.getValue());
  if (!res.ok) { alert(`Could not save file:\n${res.error}`); return; }
  await openFile(newPath);
  renderTree();
}

// ---------------- Context menu ----------------
function showContextMenu(x, y, isDirectory) {
  const menu = document.getElementById('context-menu');
  const items = [];
  if (isDirectory) {
    items.push({ label: 'New File', action: () => promptNewFile(state.contextTarget.path) });
    items.push({ label: 'New Folder', action: () => promptNewFolder(state.contextTarget.path) });
    items.push({ sep: true });
  }
  if (state.contextTarget.path !== state.projectRoot) {
    items.push({ label: 'Rename', action: () => promptRename(state.contextTarget.path) });
    items.push({ label: 'Reveal in Explorer', action: () => window.nexo.revealInFolder(state.contextTarget.path) });
    items.push({ sep: true });
    items.push({ label: 'Delete', danger: true, action: () => confirmDelete(state.contextTarget.path, isDirectory) });
  } else {
    items.push({ label: 'Reveal in Explorer', action: () => window.nexo.revealInFolder(state.contextTarget.path) });
  }

  menu.innerHTML = '';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue; }
    const d = document.createElement('div');
    d.className = 'ctx-item' + (it.danger ? ' danger' : '');
    d.textContent = it.label;
    d.addEventListener('click', () => { hideContextMenu(); it.action(); });
    menu.appendChild(d);
  }
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.remove('hidden');
}
function hideContextMenu() { document.getElementById('context-menu').classList.add('hidden'); }
document.addEventListener('click', hideContextMenu);

// ---------------- Modal (dynamic multi-field forms) ----------------
// fields: [{ id, label, placeholder, initial, required }]
// onConfirm(values) -> return an error string to keep the modal open, or null/undefined to close it.
function showModal({ title, fields, confirmLabel = 'Create', onConfirm }) {
  const overlay = document.getElementById('modal-overlay');
  const fieldsBox = document.getElementById('modal-fields');
  const errBox = document.getElementById('modal-error');
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-confirm').textContent = confirmLabel;
  errBox.textContent = '';

  fieldsBox.innerHTML = '';
  const inputs = {};
  fields.forEach((f, i) => {
    if (f.label) {
      const lbl = document.createElement('div');
      lbl.className = 'modal-field-label';
      lbl.textContent = f.label;
      fieldsBox.appendChild(lbl);
    }
    const inp = document.createElement('input');
    inp.id = `modal-field-${f.id}`;
    inp.type = 'text';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.placeholder = f.placeholder || '';
    inp.value = f.initial || '';
    inp.style.marginBottom = i < fields.length - 1 ? '10px' : '0';
    fieldsBox.appendChild(inp);
    inputs[f.id] = inp;
  });

  overlay.classList.remove('hidden');
  const firstInput = inputs[fields[0].id];
  firstInput.focus();
  firstInput.select();

  const confirmBtn = document.getElementById('modal-confirm');
  const cancelBtn = document.getElementById('modal-cancel');

  function close() {
    overlay.classList.add('hidden');
    confirmBtn.removeEventListener('click', onOk);
    cancelBtn.removeEventListener('click', onCancel);
    Object.values(inputs).forEach((inp) => inp.removeEventListener('keydown', onKey));
  }
  async function onOk() {
    const values = {};
    for (const f of fields) {
      const val = inputs[f.id].value.trim();
      if (f.required !== false && !val) { errBox.textContent = `${f.label || 'This field'} cannot be empty.`; return; }
      values[f.id] = val;
    }
    const err = await onConfirm(values);
    if (err) { errBox.textContent = err; return; }
    close();
  }
  function onCancel() { close(); }
  function onKey(e) {
    if (e.key === 'Enter') onOk();
    if (e.key === 'Escape') onCancel();
  }
  confirmBtn.addEventListener('click', onOk);
  cancelBtn.addEventListener('click', onCancel);
  Object.values(inputs).forEach((inp) => inp.addEventListener('keydown', onKey));
}

function promptNewFile(dirPath) {
  showModal({
    title: 'New File',
    fields: [{ id: 'name', placeholder: 'filename.ext' }],
    onConfirm: async ({ name }) => {
      const res = await window.nexo.createFile(dirPath, name);
      if (!res.ok) return res.error;
      state.expanded.add(dirPath);
      await renderTree();
      openFile(res.path);
      return null;
    },
  });
}

function promptNewFolder(dirPath) {
  showModal({
    title: 'New Folder',
    fields: [{ id: 'name', placeholder: 'folder-name' }],
    onConfirm: async ({ name }) => {
      const res = await window.nexo.createFolder(dirPath, name);
      if (!res.ok) return res.error;
      state.expanded.add(dirPath);
      await renderTree();
      return null;
    },
  });
}

function promptRename(targetPath) {
  const currentName = targetPath.split(/[\\/]/).pop();
  showModal({
    title: 'Rename',
    confirmLabel: 'Rename',
    fields: [{ id: 'name', initial: currentName }],
    onConfirm: async ({ name }) => {
      if (name === currentName) return null;
      const res = await window.nexo.rename(targetPath, name);
      if (!res.ok) return res.error;
      const tab = state.openTabs.find((t) => t.path === targetPath);
      if (tab) {
        tab.path = res.path;
        tab.name = name;
        if (state.activeTab === targetPath) state.activeTab = res.path;
        if (splitState.tabPath === targetPath) splitState.tabPath = res.path;
      }
      await renderTree();
      renderTabs();
      if (splitState.visible) updateSplitTabOptions();
      return null;
    },
  });
}

async function confirmDelete(targetPath, isDirectory) {
  const name = targetPath.split(/[\\/]/).pop();
  const ok = confirm(`Delete "${name}"? This cannot be undone.`);
  if (!ok) return;
  const res = await window.nexo.deleteItem(targetPath);
  if (!res.ok) { alert(`Could not delete:\n${res.error}`); return; }
  // close any open tabs under this path
  const toClose = state.openTabs.filter((t) => t.path === targetPath || t.path.startsWith(targetPath + '/') || t.path.startsWith(targetPath + '\\'));
  for (const t of toClose) {
    t.modified = false; // skip unsaved prompt, it's gone
    closeTab(t.path);
  }
  await renderTree();
}

// ---------------- Sidebar resize ----------------
(function setupResizer() {
  const resizer = document.getElementById('resizer');
  const sidebar = document.getElementById('sidebar');
  let dragging = false;
  resizer.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'col-resize'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.max(160, Math.min(500, e.clientX));
    sidebar.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; });
})();

// ---------------- Split editor pane ----------------
function ensureSplitEditor() {
  if (splitEditor) return;
  splitEditor = monaco.editor.create(document.getElementById('editor-container-split'), {
    automaticLayout: true,
    fontFamily: "'Cascadia Code', Consolas, 'JetBrains Mono', monospace",
    fontSize: uiState.fontSize,
    theme: uiState.theme === 'custom' ? 'nexo-custom' : monacoThemeId(uiState.theme),
    model: null,
    minimap: { enabled: uiState.minimap, renderCharacters: false, maxColumn: 80 },
    wordWrap: uiState.wordWrap ? 'on' : 'off',
    bracketPairColorization: { enabled: false },
    smoothScrolling: false,
    renderWhitespace: 'selection',
    occurrencesHighlight: 'off',
    wordBasedSuggestions: 'currentDocument',
  });
  addSelectAllAction(splitEditor);
}

function updateSplitTabOptions() {
  const select = document.getElementById('split-tab-select');
  select.innerHTML = '';
  for (const tab of state.openTabs) {
    const opt = document.createElement('option');
    opt.value = tab.path;
    opt.textContent = tab.name;
    if (tab.path === splitState.tabPath) opt.selected = true;
    select.appendChild(opt);
  }
}

function renderSplitMarkdownPreview(tab) {
  const box = document.getElementById('split-markdown-preview-content');
  try {
    box.innerHTML = window.marked ? marked.parse(tab.model.getValue()) : '<p>Markdown renderer not available. Run <code>npm install</code> and restart.</p>';
  } catch (err) {
    box.innerHTML = `<p>Could not render markdown: ${escapeHtml(err.message)}</p>`;
  }
}

function updateSplitDisplay() {
  const tab = state.openTabs.find((t) => t.path === splitState.tabPath);
  const toggleBtn = document.getElementById('split-md-toggle-btn');
  const previewPane = document.getElementById('split-markdown-preview');
  if (!tab || !tab.isMarkdown) {
    toggleBtn.classList.add('hidden');
    previewPane.classList.remove('active');
    return;
  }
  toggleBtn.classList.remove('hidden');
  toggleBtn.classList.toggle('on', splitState.mdMode === 'preview');
  toggleBtn.textContent = splitState.mdMode === 'preview' ? '✏️ Edit' : '👁 Preview';
  if (splitState.mdMode === 'preview') {
    renderSplitMarkdownPreview(tab);
    previewPane.classList.add('active');
  } else {
    previewPane.classList.remove('active');
  }
}

document.getElementById('split-md-toggle-btn').addEventListener('click', () => {
  splitState.mdMode = splitState.mdMode === 'preview' ? 'edit' : 'preview';
  updateSplitDisplay();
});

async function showInSplit(filePath) {
  if (!monacoLoaded) await monacoReadyPromise;
  const tab = state.openTabs.find((t) => t.path === filePath);
  if (!tab) return;
  ensureSplitEditor();
  splitState.tabPath = filePath;
  splitState.mdMode = tab.isMarkdown ? 'preview' : null;
  splitEditor.setModel(tab.model);
  document.getElementById('editor-pane-split').classList.add('active');
  document.getElementById('split-resizer').classList.add('active');
  splitState.visible = true;
  updateSplitTabOptions();
  updateSplitDisplay();
  if (editor) editor.layout();
}

function hideSplit() {
  splitState.visible = false;
  splitState.tabPath = null;
  splitState.mdMode = null;
  document.getElementById('editor-pane-split').classList.remove('active');
  document.getElementById('split-resizer').classList.remove('active');
  document.getElementById('editor-pane-split').style.width = '';
  document.getElementById('split-markdown-preview').classList.remove('active');
  if (splitEditor) splitEditor.setModel(null);
  if (editor) editor.layout();
}

async function openInSplit(filePath) {
  if (splitState.visible && splitState.tabPath === filePath) { hideSplit(); return; }
  await showInSplit(filePath);
}

function toggleSplit() {
  if (splitState.visible) { hideSplit(); return; }
  const target = splitState.tabPath && state.openTabs.some((t) => t.path === splitState.tabPath)
    ? splitState.tabPath
    : state.activeTab;
  if (!target) return; // nothing open to show
  showInSplit(target);
}

document.getElementById('split-tab-select').addEventListener('change', (e) => showInSplit(e.target.value));
document.getElementById('split-close-btn').addEventListener('click', hideSplit);
document.getElementById('btn-toggle-split').addEventListener('click', toggleSplit);

(function setupSplitResizer() {
  const resizer = document.getElementById('split-resizer');
  const pane = document.getElementById('editor-pane-split');
  let dragging = false;
  resizer.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'col-resize'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const areaRect = document.getElementById('editor-area').getBoundingClientRect();
    const w = Math.max(220, Math.min(areaRect.width * 0.75, areaRect.right - e.clientX));
    pane.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    if (editor) editor.layout();
    if (splitEditor) splitEditor.layout();
  });
})();


// ---------------- Terminal / command runner ----------------
(function setupTerminalResizer() {
  const resizer = document.getElementById('terminal-resizer');
  const panel = document.getElementById('terminal-panel');
  let dragging = false;
  resizer.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'row-resize'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const h = Math.max(100, Math.min(window.innerHeight * 0.7, window.innerHeight - e.clientY - 24));
    panel.style.height = h + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; if (editor) editor.layout(); });
})();

const termState = { activeRunId: null, history: [], historyIdx: -1 };

function termAppend(text, cls) {
  const out = document.getElementById('terminal-output');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  out.appendChild(span);
  out.scrollTop = out.scrollHeight;
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function toggleTerminal(forceShow) {
  const panel = document.getElementById('terminal-panel');
  const show = forceShow !== undefined ? forceShow : !panel.classList.contains('active');
  panel.classList.toggle('active', show);
  document.getElementById('terminal-cwd').textContent = state.projectRoot ? `— ${state.projectRoot}` : '';
  if (show) document.getElementById('terminal-input').focus();
  if (editor) editor.layout();
}

async function runTerminalCommand() {
  const input = document.getElementById('terminal-input');
  const cmd = input.value.trim();
  if (!cmd) return;
  if (!state.projectRoot) { termAppend('Open a folder first — commands run in the project root.\n', 'term-err'); return; }
  if (termState.activeRunId) return; // one command at a time; use Stop first

  termState.history.push(cmd);
  termState.historyIdx = termState.history.length;
  termAppend(`\n$ ${cmd}\n`, 'term-cmd');
  input.value = '';

  const runBtn = document.getElementById('term-run-btn');
  const res = await window.nexo.runCommand(state.projectRoot, cmd);
  if (!res.id) {
    termAppend(`[error] ${res.error || 'Could not start command.'}\n`, 'term-err');
    return;
  }
  termState.activeRunId = res.id;
  runBtn.textContent = 'Stop';
}

async function stopTerminalCommand() {
  if (!termState.activeRunId) return;
  await window.nexo.killCommand(termState.activeRunId);
}

window.nexo.onTermData((id, chunk) => {
  if (id !== termState.activeRunId) return;
  termAppend(stripAnsi(chunk));
});
window.nexo.onTermExit((id, code) => {
  if (id !== termState.activeRunId) return;
  termAppend(`[exited with code ${code}]\n`, 'term-exit');
  termState.activeRunId = null;
  document.getElementById('term-run-btn').textContent = 'Run';
});

document.getElementById('term-run-btn').addEventListener('click', () => {
  if (termState.activeRunId) stopTerminalCommand();
  else runTerminalCommand();
});
document.getElementById('terminal-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runTerminalCommand(); return; }
  if (e.key === 'ArrowUp') {
    if (termState.historyIdx > 0) { termState.historyIdx--; e.target.value = termState.history[termState.historyIdx]; }
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowDown') {
    if (termState.historyIdx < termState.history.length - 1) {
      termState.historyIdx++;
      e.target.value = termState.history[termState.historyIdx];
    } else {
      termState.historyIdx = termState.history.length;
      e.target.value = '';
    }
    e.preventDefault();
  }
});
document.getElementById('term-clear').addEventListener('click', () => {
  document.getElementById('terminal-output').innerHTML = '';
});
document.getElementById('term-close').addEventListener('click', () => toggleTerminal(false));
document.getElementById('btn-toggle-terminal').addEventListener('click', () => toggleTerminal());

// ---------------- Toolbar / menu wiring ----------------
let openInProgress = false;
async function handleOpenFolder() {
  if (openInProgress) return;
  openInProgress = true;
  try {
    const res = await window.nexo.openFolder();
    if (res) await openProject(res.folder);
  } finally {
    openInProgress = false;
  }
}
async function handleNewProject() {
  if (openInProgress) return;
  openInProgress = true;
  try {
    const res = await window.nexo.newProject();
    if (res) await openProject(res.folder);
  } finally {
    openInProgress = false;
  }
}
function handleNewFile() {
  if (!state.projectRoot) { alert('Open a folder first.'); return; }
  promptNewFile(state.projectRoot);
}

document.getElementById('btn-open-folder').addEventListener('click', handleOpenFolder);
document.getElementById('welcome-open').addEventListener('click', handleOpenFolder);
document.getElementById('welcome-new').addEventListener('click', handleNewProject);
document.getElementById('btn-new-file').addEventListener('click', handleNewFile);
document.getElementById('btn-add-file').addEventListener('click', () => state.projectRoot && promptNewFile(state.projectRoot));
document.getElementById('btn-add-folder').addEventListener('click', () => state.projectRoot && promptNewFolder(state.projectRoot));

document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveActiveTabAs(); return; }
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); saveActiveTab(); }
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); handleOpenFolder(); }
  if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); handleNewFile(); }
  if (ctrl && e.key.toLowerCase() === 'w' && state.activeTab) { e.preventDefault(); closeTab(state.activeTab); }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); switchRailView('search'); }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); switchRailView('git'); }
  if (ctrl && e.key === '`') { e.preventDefault(); toggleTerminal(); }
  if (ctrl && e.key === '\\') { e.preventDefault(); toggleSplit(); }
  if (ctrl && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    const sb = document.getElementById('sidebar');
    sb.style.display = sb.style.display === 'none' ? 'flex' : 'none';
  }
});

if (window.nexo.onMenu) {
  window.nexo.onMenu('menu:open-folder', handleOpenFolder);
  window.nexo.onMenu('menu:new-file', handleNewFile);
  window.nexo.onMenu('menu:save', saveActiveTab);
  window.nexo.onMenu('menu:save-as', saveActiveTabAs);
  window.nexo.onMenu('menu:show-search', () => switchRailView('search'));
  window.nexo.onMenu('menu:show-git', () => switchRailView('git'));
  window.nexo.onMenu('menu:toggle-terminal', () => toggleTerminal());
  window.nexo.onMenu('menu:toggle-split', () => toggleSplit());
  window.nexo.onMenu('menu:toggle-sidebar', () => {
    const sb = document.getElementById('sidebar');
    sb.style.display = sb.style.display === 'none' ? 'flex' : 'none';
  });
}

if (window.nexo.onSitesUpdated) {
  window.nexo.onSitesUpdated((list) => {
    sitesState.sites = list;
    renderSitesList();
    if (sitesState.selectedId) renderSiteDetail();
  });
}

window.addEventListener('beforeunload', (e) => {
  const dirty = state.openTabs.some((t) => t.modified);
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ==================================================================
// Sites workspace — uptime monitoring + SEO audits
// ==================================================================
const sitesState = {
  sites: [],
  selectedId: null,
  checking: new Set(), // ids currently being checked/audited (for spinner state)
};

function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function loadSites() {
  sitesState.sites = await window.nexo.getSites();
  renderSitesList();
  if (sitesState.selectedId) renderSiteDetail();
}

function renderSitesList() {
  const box = document.getElementById('sites-list');
  const empty = document.getElementById('sites-list-empty');
  box.innerHTML = '';
  empty.style.display = sitesState.sites.length ? 'none' : 'block';

  for (const site of sitesState.sites) {
    const row = document.createElement('div');
    row.className = 'site-row' + (site.id === sitesState.selectedId ? ' active' : '');
    let dotClass = 'gray';
    if (site.lastCheck) dotClass = site.lastCheck.ok ? 'green' : 'red';
    if (sitesState.checking.has(site.id)) dotClass = 'pulsing';
    row.innerHTML = `
      <span class="site-dot ${dotClass}"></span>
      <span class="site-row-text">
        <span class="site-row-name">${escapeHtml(site.name)}</span>
        <span class="site-row-url">${escapeHtml(site.url.replace(/^https?:\/\//, ''))}</span>
      </span>
    `;
    row.addEventListener('click', () => selectSite(site.id));
    box.appendChild(row);
  }
}

function selectSite(id) {
  sitesState.selectedId = id;
  document.getElementById('sites-welcome').style.display = 'none';
  document.getElementById('site-detail').style.display = 'block';
  renderSitesList();
  renderSiteDetail();
}

function scoreColor(score) {
  if (score >= 80) return 'var(--ok)';
  if (score >= 50) return '#e6b83c';
  return 'var(--danger)';
}

function buildSparkline(history) {
  if (!history || !history.length) return '<span class="trend-empty">No check history yet.</span>';
  const recent = history.slice(-30);
  const upCount = recent.filter((h) => h.ok).length;
  const pct = Math.round((upCount / recent.length) * 100);
  const maxMs = Math.max(...recent.map((h) => h.ms || 0), 1);
  const bars = recent.map((h) => {
    const heightPct = h.ok ? Math.max(15, Math.round(((h.ms || 0) / maxMs) * 100)) : 100;
    const cls = h.ok ? 'up' : 'down';
    const title = h.ok ? `${h.ms}ms — ${new Date(h.ts).toLocaleString()}` : `Down — ${new Date(h.ts).toLocaleString()}`;
    return `<div class="spark-bar ${cls}" style="height:${heightPct}%" title="${escapeHtml(title)}"></div>`;
  }).join('');
  return `<div class="sparkline-wrap">${bars}</div><span class="uptime-pct"><b>${pct}%</b> up over last ${recent.length} check${recent.length === 1 ? '' : 's'}</span>`;
}

function buildAuditTrend(auditHistory) {
  if (!auditHistory || auditHistory.length < 2) return '';
  const recent = auditHistory.slice(-20);
  const bars = recent.map((a) => {
    const h = Math.max(6, a.score);
    const color = a.score >= 80 ? 'var(--ok)' : a.score >= 50 ? '#e6b83c' : 'var(--danger)';
    return `<div class="trend-bar" style="height:${h}%;background:${color}" title="${a.score}/100 — ${new Date(a.ts).toLocaleString()}"></div>`;
  }).join('');
  return `<h3 class="section-title">Score History</h3><div class="trend-row">${bars}</div>`;
}

function renderSiteDetail() {
  const site = sitesState.sites.find((s) => s.id === sitesState.selectedId);
  const box = document.getElementById('site-detail');
  if (!site) { box.style.display = 'none'; document.getElementById('sites-welcome').style.display = 'flex'; return; }

  const checking = sitesState.checking.has(site.id);
  const check = site.lastCheck;
  const statusHtml = !check
    ? `<span class="badge gray">Not checked yet</span>`
    : check.ok
      ? `<span class="badge green">Up</span> <span class="detail-muted">${check.status} · ${check.ms}ms · ${timeAgo(check.checkedAt)}</span>`
      : `<span class="badge red">Down</span> <span class="detail-muted">${escapeHtml(check.error || `Status ${check.status}`)} · ${timeAgo(check.checkedAt)}</span>`;

  let auditHtml = '';
  const audit = site.lastAudit;
  if (audit && audit.ok) {
    const rows = audit.breakdown.map((b) => `
      <div class="audit-row">
        <span class="audit-icon ${b.pass ? 'pass' : 'fail'}">${b.pass ? '✓' : '✗'}</span>
        <span class="audit-label">${escapeHtml(b.label)}</span>
        <span class="audit-points">${b.points}/${b.max}</span>
        <span class="audit-detail">${escapeHtml(b.detail)}</span>
      </div>
    `).join('');
    auditHtml = `
      <div class="audit-score-row">
        <div class="score-circle" style="--score-color:${scoreColor(audit.score)}">
          <span>${audit.score}</span><small>/100</small>
        </div>
        <div class="detail-muted">Audited ${timeAgo(audit.auditedAt)}</div>
      </div>
      <div class="audit-breakdown">${rows}</div>
      ${buildAuditTrend(site.auditHistory)}
    `;
  } else if (audit && !audit.ok) {
    auditHtml = `<p class="detail-muted">Audit failed: ${escapeHtml(audit.error || 'unknown error')}</p>`;
  } else {
    auditHtml = `<p class="detail-muted">No SEO audit run yet.</p>`;
  }

  const intervalOptions = [5, 10, 15, 30, 60, 120].map((m) =>
    `<option value="${m}" ${site.intervalMinutes === m ? 'selected' : ''}>${m < 60 ? `${m}m` : `${m / 60}h`}</option>`
  ).join('');

  box.innerHTML = `
    <div class="detail-header">
      <div>
        <h2>${escapeHtml(site.name)}</h2>
        <a href="#" id="site-open-link" class="site-url-link">${escapeHtml(site.url)} ↗</a>
      </div>
      <div class="detail-header-actions">
        <button class="tbtn" id="site-check-btn" ${checking ? 'disabled' : ''}>${checking ? 'Checking…' : 'Check Now'}</button>
        <button class="tbtn" id="site-audit-btn" ${checking ? 'disabled' : ''}>${checking ? 'Running…' : 'Run SEO Audit'}</button>
        <button class="tbtn danger-tbtn" id="site-remove-btn">Remove</button>
      </div>
    </div>
    <div class="status-line">${statusHtml}</div>
    <div class="uptime-row">
      ${buildSparkline(site.history)}
      <span class="interval-control">Auto-check every
        <select id="site-interval">${intervalOptions}</select>
      </span>
    </div>
    <h3 class="section-title">SEO Audit</h3>
    ${auditHtml}
  `;
  box.style.display = 'block';
  document.getElementById('sites-welcome').style.display = 'none';

  document.getElementById('site-open-link').addEventListener('click', (e) => { e.preventDefault(); window.nexo.openExternal(site.url); });
  document.getElementById('site-check-btn').addEventListener('click', () => checkSite(site.id));
  document.getElementById('site-audit-btn').addEventListener('click', () => auditSite(site.id));
  document.getElementById('site-remove-btn').addEventListener('click', () => removeSite(site.id));
  document.getElementById('site-interval').addEventListener('change', async (e) => {
    sitesState.sites = await window.nexo.setSiteInterval(site.id, e.target.value);
  });
}

async function checkSite(id) {
  sitesState.checking.add(id);
  renderSitesList();
  if (id === sitesState.selectedId) renderSiteDetail();
  const updated = await window.nexo.checkSite(id);
  sitesState.checking.delete(id);
  if (updated) {
    const idx = sitesState.sites.findIndex((s) => s.id === id);
    if (idx !== -1) sitesState.sites[idx] = updated;
  }
  renderSitesList();
  if (id === sitesState.selectedId) renderSiteDetail();
}

async function auditSite(id) {
  sitesState.checking.add(id);
  renderSitesList();
  if (id === sitesState.selectedId) renderSiteDetail();
  const updated = await window.nexo.auditSite(id);
  sitesState.checking.delete(id);
  if (updated) {
    const idx = sitesState.sites.findIndex((s) => s.id === id);
    if (idx !== -1) sitesState.sites[idx] = updated;
  }
  renderSitesList();
  if (id === sitesState.selectedId) renderSiteDetail();
}

async function removeSite(id) {
  const site = sitesState.sites.find((s) => s.id === id);
  if (!site) return;
  const ok = confirm(`Stop monitoring "${site.name}"?`);
  if (!ok) return;
  sitesState.sites = await window.nexo.removeSite(id);
  if (sitesState.selectedId === id) sitesState.selectedId = null;
  renderSitesList();
  renderSiteDetail();
}

function addSiteFlow() {
  showModal({
    title: 'Add Site to Monitor',
    confirmLabel: 'Add Site',
    fields: [
      { id: 'url', label: 'Website URL', placeholder: 'example.com' },
      { id: 'name', label: 'Display name (optional)', placeholder: 'My Site', required: false },
    ],
    onConfirm: async ({ url, name }) => {
      try { new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); }
      catch { return 'That doesn\'t look like a valid URL.'; }
      sitesState.sites = await window.nexo.addSite(url, name);
      renderSitesList();
      const newest = sitesState.sites[0];
      selectSite(newest.id);
      checkSite(newest.id);
      auditSite(newest.id);
      return null;
    },
  });
}

document.getElementById('btn-add-site').addEventListener('click', addSiteFlow);
document.getElementById('sites-welcome-add').addEventListener('click', addSiteFlow);

// ---------------- Global search ----------------
let searchDebounceTimer = null;
async function runSearch() {
  const query = document.getElementById('search-input').value;
  const summary = document.getElementById('search-summary');
  const results = document.getElementById('search-results');
  if (!state.projectRoot) {
    summary.textContent = 'Open a folder to search its files.';
    results.innerHTML = '';
    return;
  }
  if (!query.trim()) {
    summary.textContent = '';
    results.innerHTML = '';
    return;
  }
  summary.textContent = 'Searching…';
  const caseSensitive = document.getElementById('search-case').checked;
  const res = await window.nexo.searchText(state.projectRoot, query, { caseSensitive });
  renderSearchResults(res, query);
}

function highlightMatch(text, query, caseSensitive) {
  const idx = caseSensitive ? text.indexOf(query) : text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx)) + '<mark>' + escapeHtml(text.slice(idx, idx + query.length)) + '</mark>' + escapeHtml(text.slice(idx + query.length));
}

function renderSearchResults(res, query) {
  const summary = document.getElementById('search-summary');
  const container = document.getElementById('search-results');
  container.innerHTML = '';
  const totalMatches = res.matches.reduce((sum, f) => sum + f.matches.length, 0);
  if (!res.matches.length) {
    summary.textContent = 'No results found.';
    return;
  }
  summary.textContent = `${totalMatches} result${totalMatches === 1 ? '' : 's'} in ${res.matches.length} file${res.matches.length === 1 ? '' : 's'}${res.truncated ? ' (truncated)' : ''}`;
  const caseSensitive = document.getElementById('search-case').checked;

  for (const fileResult of res.matches) {
    const group = document.createElement('div');
    group.className = 'search-file-group';
    const relName = fileResult.path.startsWith(state.projectRoot) ? fileResult.path.slice(state.projectRoot.length + 1) : fileResult.path;

    const header = document.createElement('div');
    header.className = 'search-file-header';
    header.innerHTML = `<span class="ficon">${fileIcon(fileResult.path.split(/[\\/]/).pop(), false)}</span><span>${escapeHtml(relName)}</span><span class="count">${fileResult.matches.length}</span>`;
    group.appendChild(header);

    const rowsBox = document.createElement('div');
    for (const m of fileResult.matches) {
      const row = document.createElement('div');
      row.className = 'search-match-row';
      row.innerHTML = `<span class="lineno">${m.line}:</span>${highlightMatch(m.preview, query, caseSensitive)}`;
      row.addEventListener('click', async () => {
        await openFile(fileResult.path);
        if (editor) {
          editor.revealLineInCenter(m.line);
          editor.setPosition({ lineNumber: m.line, column: m.col });
          editor.focus();
        }
      });
      rowsBox.appendChild(row);
    }
    group.appendChild(rowsBox);
    header.addEventListener('click', () => rowsBox.classList.toggle('collapsed'));
    container.appendChild(group);
  }
}

document.getElementById('search-input').addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(runSearch, 300);
});
document.getElementById('search-case').addEventListener('change', runSearch);

// ---------------- Git / Source Control ----------------
const gitState = { root: null, staged: [], unstaged: [], conflicts: [], available: false, activePath: null, activeStaged: false, activeCommit: null, subtab: 'changes' };

function relToGitRoot(fullPath) {
  if (!gitState.root) return null;
  const rootNorm = gitState.root.replace(/\\/g, '/');
  const full = fullPath.replace(/\\/g, '/');
  if (!full.startsWith(rootNorm)) return null;
  return full.slice(rootNorm.length + 1);
}

function gitDecorationFor(fullPath) {
  if (!gitState.available) return null;
  const rel = relToGitRoot(fullPath);
  if (rel == null) return null;
  const entry = gitState.unstaged.find((e) => e.path === rel) || gitState.staged.find((e) => e.path === rel);
  if (!entry) return null;
  const cls = entry.status === '?' ? 'Q' : (['M', 'A', 'D', 'R', 'U'].includes(entry.status) ? entry.status : 'Q');
  return { letter: gitBadgeChar(entry.status), cls };
}

async function refreshGitStatus() {
  const branchLabel = document.getElementById('git-branch-current');
  const pushBtn = document.getElementById('git-push-btn');
  const pullBtn = document.getElementById('git-pull-btn');
  if (!state.projectRoot) {
    branchLabel.textContent = '—';
    document.getElementById('git-ahead-behind').textContent = '';
    pushBtn.disabled = true;
    pullBtn.disabled = true;
    document.getElementById('git-body').innerHTML = '<div class="git-empty">Open a folder first.</div>';
    updateGitRailBadge();
    return;
  }
  const res = await window.nexo.gitStatus(state.projectRoot);
  if (!res.ok) {
    gitState.available = false;
    branchLabel.textContent = '—';
    document.getElementById('git-ahead-behind').textContent = '';
    pushBtn.disabled = true;
    pullBtn.disabled = true;
    document.getElementById('git-body').innerHTML = `<div class="git-empty">${escapeHtml(res.error || 'Not a git repository.')}</div>`;
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
  branchLabel.textContent = `🌿 ${res.branch || '(detached)'}`;
  pushBtn.disabled = false;
  pullBtn.disabled = false;
  if (gitState.subtab === 'history') renderGitHistory();
  else renderGitPanel();
  renderTree();
  updateGitRailBadge();
  refreshRemoteStatus();
}

async function refreshRemoteStatus() {
  const label = document.getElementById('git-ahead-behind');
  const pullBtn = document.getElementById('git-pull-btn');
  if (!gitState.available) { label.textContent = ''; return; }
  const res = await window.nexo.gitRemoteStatus(state.projectRoot);
  if (!res.ok || !res.hasUpstream) {
    label.textContent = res.ok ? 'no upstream' : '';
    pullBtn.disabled = !res.ok;
    return;
  }
  const parts = [];
  if (res.ahead) parts.push(`<span class="ahead">↑${res.ahead}</span>`);
  if (res.behind) parts.push(`<span class="behind">↓${res.behind}</span>`);
  label.innerHTML = parts.length ? parts.join(' ') : 'up to date';
}

async function gitPushFlow() {
  const btn = document.getElementById('git-push-btn');
  btn.disabled = true;
  btn.textContent = '⬆ Pushing…';
  const res = await window.nexo.gitPush(state.projectRoot);
  btn.textContent = '⬆ Push';
  btn.disabled = false;
  if (!res.ok) { alert(`Push failed:\n${res.error}`); return; }
  refreshRemoteStatus();
}

async function gitPullFlow() {
  const btn = document.getElementById('git-pull-btn');
  btn.disabled = true;
  btn.textContent = '⬇ Pulling…';
  const res = await window.nexo.gitPull(state.projectRoot);
  btn.textContent = '⬇ Pull';
  btn.disabled = false;
  if (!res.ok) { alert(`Pull failed:\n${res.error}`); return; }
  await renderTree();
  refreshGitStatus();
}

document.getElementById('git-push-btn').addEventListener('click', gitPushFlow);
document.getElementById('git-pull-btn').addEventListener('click', gitPullFlow);

function updateGitRailBadge() {
  const badge = document.getElementById('rail-git-badge');
  if (!badge) return;
  // De-dupe: a file that's both staged and unstaged (partially staged) should
  // only count once, same as VS Code's changed-file count.
  const paths = new Set([...gitState.staged.map((e) => e.path), ...gitState.unstaged.map((e) => e.path), ...gitState.conflicts.map((e) => e.path)]);
  const count = gitState.available ? paths.size : 0;
  badge.textContent = gitState.conflicts.length ? '!' : (count > 99 ? '99+' : String(count));
  badge.classList.toggle('hidden', count === 0);
  badge.classList.toggle('conflict', gitState.conflicts.length > 0);
  document.getElementById('rail-git').title = gitState.available
    ? `Source Control (Ctrl+Shift+G) — ${gitState.conflicts.length ? `${gitState.conflicts.length} conflict${gitState.conflicts.length === 1 ? '' : 's'}, ` : ''}${count} change${count === 1 ? '' : 's'} on ${gitState.branch || 'detached HEAD'}`
    : 'Source Control (Ctrl+Shift+G)';
}

function renderGitPanel() {
  gitState.subtab = 'changes';
  document.getElementById('git-tab-changes').classList.add('active');
  document.getElementById('git-tab-history').classList.remove('active');

  const body = document.getElementById('git-body');
  body.innerHTML = '';

  if (!gitState.available) {
    body.innerHTML = '<div class="git-empty">Not a git repository.</div>';
    return;
  }

  if (!gitState.staged.length && !gitState.unstaged.length && !gitState.conflicts.length) {
    const empty = document.createElement('div');
    empty.className = 'git-empty';
    empty.textContent = 'No changes — working tree clean.';
    body.appendChild(empty);
  } else {
    if (gitState.conflicts.length) {
      const t = document.createElement('div');
      t.className = 'git-section-title conflict-title';
      t.textContent = `MERGE CONFLICTS (${gitState.conflicts.length})`;
      body.appendChild(t);
      for (const entry of gitState.conflicts) body.appendChild(renderConflictRow(entry));
    }
    if (gitState.staged.length) {
      const t = document.createElement('div');
      t.className = 'git-section-title';
      t.textContent = `STAGED CHANGES (${gitState.staged.length})`;
      body.appendChild(t);
      for (const entry of gitState.staged) body.appendChild(renderGitFileRow(entry, true));
    }
    if (gitState.unstaged.length) {
      const t = document.createElement('div');
      t.className = 'git-section-title';
      t.textContent = `CHANGES (${gitState.unstaged.length})`;
      body.appendChild(t);
      for (const entry of gitState.unstaged) body.appendChild(renderGitFileRow(entry, false));
    }
  }

  const commitBox = document.createElement('div');
  commitBox.id = 'git-commit-box';
  commitBox.innerHTML = `
    <textarea id="git-commit-msg" placeholder="Commit message…"></textarea>
    <button id="git-commit-btn" ${gitState.staged.length ? '' : 'disabled'}>Commit ${gitState.staged.length ? `(${gitState.staged.length})` : ''}</button>
  `;
  body.appendChild(commitBox);
  document.getElementById('git-commit-btn').addEventListener('click', async () => {
    const msg = document.getElementById('git-commit-msg').value.trim();
    if (!msg) return;
    const res = await window.nexo.gitCommit(state.projectRoot, msg);
    if (!res.ok) { alert(`Commit failed:\n${res.error}`); return; }
    hideDiff();
    refreshGitStatus();
  });
}

async function renderGitHistory() {
  gitState.subtab = 'history';
  document.getElementById('git-tab-history').classList.add('active');
  document.getElementById('git-tab-changes').classList.remove('active');

  const body = document.getElementById('git-body');
  if (!gitState.available) { body.innerHTML = '<div class="git-empty">Not a git repository.</div>'; return; }
  body.innerHTML = '<div class="git-empty">Loading history…</div>';

  const res = await window.nexo.gitLog(state.projectRoot, 50);
  if (!res.ok) { body.innerHTML = `<div class="git-empty">${escapeHtml(res.error || 'Could not load history.')}</div>`; return; }
  if (!res.commits.length) { body.innerHTML = '<div class="git-empty">No commits yet.</div>'; return; }

  body.innerHTML = '';
  for (const c of res.commits) {
    const row = document.createElement('div');
    row.className = 'commit-row' + (gitState.activeCommit === c.hash ? ' active' : '');
    row.innerHTML = `
      <div class="commit-subject" title="${escapeHtml(c.subject)}">${escapeHtml(c.subject)}</div>
      <div class="commit-meta"><span class="hash">${escapeHtml(c.short)}</span>${escapeHtml(c.author)} · ${escapeHtml(c.date)}</div>
    `;
    row.addEventListener('click', () => showCommitDiff(c.hash, c.short, c.subject));
    body.appendChild(row);
  }
}

document.getElementById('git-tab-changes').addEventListener('click', renderGitPanel);
document.getElementById('git-tab-history').addEventListener('click', renderGitHistory);

// ---------------- Branch switching ----------------
async function openBranchDropdown() {
  const existing = document.getElementById('git-branch-dropdown');
  if (existing) { existing.remove(); return; }
  if (!state.projectRoot) return;

  const dropdown = document.createElement('div');
  dropdown.id = 'git-branch-dropdown';
  dropdown.innerHTML = '<div class="branch-item">Loading…</div>';
  document.getElementById('git-branch-row').appendChild(dropdown);

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
      onConfirm: async ({ name }) => {
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

document.getElementById('git-branch-switch-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  openBranchDropdown();
});
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('git-branch-dropdown');
  if (dropdown && !dropdown.contains(e.target) && e.target.id !== 'git-branch-switch-btn') dropdown.remove();
});

document.getElementById('btn-git-refresh').addEventListener('click', refreshGitStatus);



function gitBadgeChar(status) {
  return { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', '?': 'U' }[status] || status;
}

function renderGitFileRow(entry, staged) {
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
      await window.nexo.gitUnstage(state.projectRoot, entry.path);
      refreshGitStatus();
    });
    actions.appendChild(unstageBtn);
  } else {
    const stageBtn = document.createElement('button');
    stageBtn.className = 'git-row-btn';
    stageBtn.textContent = '+';
    stageBtn.title = 'Stage';
    stageBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.nexo.gitStage(state.projectRoot, entry.path);
      refreshGitStatus();
    });
    actions.appendChild(stageBtn);

    if (entry.status !== '?') {
      const discardBtn = document.createElement('button');
      discardBtn.className = 'git-row-btn';
      discardBtn.textContent = '↺';
      discardBtn.title = 'Discard changes';
      discardBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Discard changes to "${entry.path}"? This cannot be undone.`)) return;
        await window.nexo.gitDiscard(state.projectRoot, entry.path);
        refreshGitStatus();
      });
      actions.appendChild(discardBtn);
    }
  }

  row.addEventListener('click', () => showDiff(entry.path, staged));
  return row;
}

function renderConflictRow(entry) {
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
    await window.nexo.gitStage(state.projectRoot, entry.path);
    refreshGitStatus();
  });
  actions.appendChild(resolveBtn);

  // Opening a conflicted file goes straight to the editor (not a diff) so the
  // conflict-resolution banner can help resolve it inline.
  row.addEventListener('click', () => {
    if (!gitState.root) return;
    openFile(`${gitState.root}/${entry.path}`);
  });
  return row;
}

// ---------------- Diff viewer ----------------
function parseDiffToHtml(diffText) {
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

async function showDiff(relPath, staged) {
  gitState.activePath = relPath;
  gitState.activeStaged = staged;
  gitState.activeCommit = null;
  renderGitPanel();

  document.getElementById('welcome').style.display = 'none';
  if (editor) document.getElementById('editor-container').style.display = 'none';
  document.getElementById('markdown-preview').style.display = 'none';
  document.getElementById('md-preview-btn').classList.add('hidden');
  document.getElementById('conflict-banner').classList.remove('active');

  let diffContainer = document.getElementById('diff-container');
  diffContainer.style.display = 'block';
  diffContainer.innerHTML = '<div class="diff-line meta">Loading diff…</div>';
  document.getElementById('status-path').textContent = `${relPath} (${staged ? 'staged' : 'working tree'} diff)`;
  document.getElementById('status-lang').textContent = '';

  const res = await window.nexo.gitDiff(state.projectRoot, relPath, staged);
  if (!res.ok) {
    diffContainer.innerHTML = `<div class="diff-line meta">${escapeHtml(res.error || 'Could not load diff.')}</div>`;
    return;
  }
  diffContainer.innerHTML = `<div class="diff-view">${parseDiffToHtml(res.diff)}</div>`;
}

async function showCommitDiff(hash, short, subject) {
  gitState.activePath = null;
  gitState.activeCommit = hash;
  renderGitHistory();

  document.getElementById('welcome').style.display = 'none';
  if (editor) document.getElementById('editor-container').style.display = 'none';
  document.getElementById('markdown-preview').style.display = 'none';
  document.getElementById('md-preview-btn').classList.add('hidden');
  document.getElementById('conflict-banner').classList.remove('active');

  let diffContainer = document.getElementById('diff-container');
  diffContainer.style.display = 'block';
  diffContainer.innerHTML = '<div class="diff-line meta">Loading commit…</div>';
  document.getElementById('status-path').textContent = `${short} — ${subject}`;
  document.getElementById('status-lang').textContent = '';

  const res = await window.nexo.gitShowCommit(state.projectRoot, hash);
  if (!res.ok) {
    diffContainer.innerHTML = `<div class="diff-line meta">${escapeHtml(res.error || 'Could not load commit.')}</div>`;
    return;
  }
  diffContainer.innerHTML = `<div class="diff-view">${parseDiffToHtml(res.diff)}</div>`;
}

function hideDiff() {
  gitState.activePath = null;
  gitState.activeCommit = null;
  const diffContainer = document.getElementById('diff-container');
  if (diffContainer) diffContainer.style.display = 'none';
  if (state.activeTab) {
    document.getElementById('editor-container').style.display = 'block';
    activateTab(state.activeTab);
  } else {
    document.getElementById('welcome').style.display = 'flex';
  }
}

// ---------------- Merge conflict resolution ----------------
// Scans a model's text for git's standard conflict markers and returns the
// line ranges of each block found, in document order.
function scanConflicts(model) {
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

let conflictDecorations = null;
function updateConflictDecorations(conflicts) {
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
  if (!editor || !state.activeTab || document.getElementById('diff-container').style.display === 'block') {
    banner.classList.remove('active');
    container.classList.remove('push-down');
    updateConflictDecorations([]);
    return;
  }
  const conflicts = scanConflicts(editor.getModel());
  updateConflictDecorations(conflicts);
  if (!conflicts.length) {
    banner.classList.remove('active');
    container.classList.remove('push-down');
    return;
  }
  document.getElementById('conflict-count').textContent = `⚠ ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} in this file`;
  banner.classList.add('active');
  container.classList.add('push-down');
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

function resolveConflict(mode) {
  const c = getConflictNearCursor();
  if (!c || !editor) return;
  const model = editor.getModel();
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

  editor.executeEdits('resolve-conflict', [{ range, text }]);
  editor.focus();
  updateConflictBanner();
}

function jumpToNextConflict() {
  const c = getConflictNearCursor();
  if (!c || !editor) return;
  editor.revealLineInCenter(c.startLine);
  editor.setPosition({ lineNumber: c.startLine, column: 1 });
  editor.focus();
}

document.getElementById('conflict-current').addEventListener('click', () => resolveConflict('current'));
document.getElementById('conflict-incoming').addEventListener('click', () => resolveConflict('incoming'));
document.getElementById('conflict-both').addEventListener('click', () => resolveConflict('both'));
document.getElementById('conflict-next').addEventListener('click', jumpToNextConflict);

// ---------------- Workspace / panel switching (activity rail) ----------------
const FULL_WORKSPACES = { sites: 'workspace-sites', settings: 'workspace-settings' };

function switchRailView(view) {
  document.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

  if (FULL_WORKSPACES[view]) {
    document.getElementById('workspace-explorer').classList.remove('active');
    for (const [id, elId] of Object.entries(FULL_WORKSPACES)) {
      document.getElementById(elId).classList.toggle('active', id === view);
    }
    if (view === 'settings') renderSettingsPage();
    return;
  }

  document.getElementById('workspace-explorer').classList.add('active');
  for (const elId of Object.values(FULL_WORKSPACES)) document.getElementById(elId).classList.remove('active');
  document.querySelectorAll('.sidebar-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${view}`));

  if (editor) editor.layout();
  if (view === 'search') document.getElementById('search-input').focus();
  if (view === 'git') refreshGitStatus();
}

document.querySelectorAll('.rail-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchRailView(btn.dataset.view));
});

// ---------------- Settings page ----------------
function applyEditorOptionToBoth(opts) {
  if (editor) editor.updateOptions(opts);
  if (splitEditor) splitEditor.updateOptions(opts);
}

function renderPresetChips() {
  if (!uiState.customThemes.length) {
    return '<span class="trend-empty">No saved presets yet.</span>';
  }
  return uiState.customThemes.map((p) => `
    <div class="settings-theme-card preset-chip" data-preset-id="${p.id}" title="${escapeHtml(p.name)}">
      <span class="swatch" style="background:${p.accent}"></span><span>${escapeHtml(p.name)}</span>
      <span class="preset-remove" data-preset-id="${p.id}" title="Delete preset">✕</span>
    </div>
  `).join('');
}

function renderSettingsPage() {
  const page = document.getElementById('settings-page');
  const themeCards = [...THEMES, { ...CUSTOM_THEME_META, swatch: uiState.customTheme.accent }].map((t) => `
    <div class="settings-theme-card ${t.id === uiState.theme ? 'current' : ''}" data-theme-id="${t.id}">
      <span class="swatch" style="background:${t.swatch}"></span><span>${t.label}</span>
    </div>
  `).join('');
  const intervalOptions = [5, 10, 15, 30, 60, 120].map((m) =>
    `<option value="${m}" ${uiState.defaultSiteInterval === m ? 'selected' : ''}>${m < 60 ? `${m}m` : `${m / 60}h`}</option>`
  ).join('');

  page.innerHTML = `
    <h1 class="settings-title">Settings</h1>
    <p class="settings-subtitle">Changes apply immediately and are remembered across restarts.</p>

    <div class="settings-section">
      <h2>Appearance</h2>
      <div class="settings-row">
        <div><div class="settings-row-label">Theme</div></div>
        <div class="settings-control"><div class="settings-theme-grid">${themeCards}</div></div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Custom theme colors</div>
          <div class="settings-row-desc">Pick a background, text, and accent color — everything else (panels, borders, diff highlights, etc.) is generated automatically to match. Changing any of these switches to the Custom theme.</div>
        </div>
        <div class="settings-control">
          <input type="color" class="settings-color" id="set-custom-bg" value="${uiState.customTheme.bg}" title="Background" />
          <input type="color" class="settings-color" id="set-custom-text" value="${uiState.customTheme.text}" title="Text" />
          <input type="color" class="settings-color" id="set-custom-accent" value="${uiState.customTheme.accent}" title="Accent" />
          <button class="icon-btn" id="set-save-preset-btn" title="Save these colors as a named preset">＋ Save preset</button>
        </div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Saved presets</div>
          <div class="settings-row-desc">Your saved custom-theme color combinations. Click one to apply it, or the ✕ to delete it.</div>
        </div>
        <div class="settings-control"><div class="settings-theme-grid" id="preset-list">${renderPresetChips()}</div></div>
      </div>
      <div class="settings-row">
        <div><div class="settings-row-label">Font size</div></div>
        <div class="settings-control">
          <input type="number" class="settings-number" id="set-font-size" min="9" max="28" step="0.5" value="${uiState.fontSize}" />
        </div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Minimap</div>
          <div class="settings-row-desc">The small code overview on the right edge of the editor. Auto-disabled on large files regardless of this setting.</div>
        </div>
        <div class="settings-control"><div class="settings-toggle ${uiState.minimap ? 'on' : ''}" id="set-minimap"></div></div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Word wrap</div>
          <div class="settings-row-desc">Wrap long lines instead of scrolling horizontally.</div>
        </div>
        <div class="settings-control"><div class="settings-toggle ${uiState.wordWrap ? 'on' : ''}" id="set-word-wrap"></div></div>
      </div>
    </div>

    <div class="settings-section">
      <h2>Editor</h2>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Auto Save</div>
          <div class="settings-row-desc">Automatically save the active file a short while after you stop typing.</div>
        </div>
        <div class="settings-control"><div class="settings-toggle ${uiState.autoSave ? 'on' : ''}" id="set-autosave"></div></div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Auto Save delay</div>
          <div class="settings-row-desc">How long to wait after you stop typing before saving.</div>
        </div>
        <div class="settings-control">
          <input type="number" class="settings-number" id="set-autosave-delay" min="200" max="10000" step="100" value="${uiState.autoSaveDelayMs}" /> ms
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h2>Sites Monitor</h2>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Default check interval</div>
          <div class="settings-row-desc">Used automatically whenever you add a new site to monitor. Can still be changed per-site afterward.</div>
        </div>
        <div class="settings-control"><select class="settings-select" id="set-site-interval">${intervalOptions}</select></div>
      </div>
    </div>

    <div class="settings-section">
      <h2>Terminal</h2>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Custom shell</div>
          <div class="settings-row-desc">Optional. Overrides the default shell (Command Prompt on Windows) used by the Terminal panel — e.g. a path to PowerShell or Git Bash. Leave blank to use the system default.</div>
        </div>
        <div class="settings-control"><input type="text" class="settings-text" id="set-custom-shell" placeholder="e.g. powershell.exe" value="${escapeHtml(uiState.customShell || '')}" /></div>
      </div>
    </div>

    <div class="settings-section">
      <h2>About</h2>
      <div class="settings-about">
        <img src="icons/logo-96.png" alt="" />
        <div>
          <div class="settings-about-name">Nexo Dev</div>
          <div class="settings-about-meta">A fast, focused editor for your projects — built for the Nexo network.</div>
        </div>
      </div>
    </div>
  `;

  // ---- wire it all up ----
  page.querySelectorAll('.settings-theme-card').forEach((card) => {
    if (!card.dataset.themeId) return; // preset chips share this class for styling but are wired separately below
    card.addEventListener('click', () => {
      applyTheme(card.dataset.themeId);
      page.querySelectorAll('.settings-theme-card').forEach((c) => c.classList.toggle('current', c === card));
    });
  });

  document.getElementById('set-save-preset-btn').addEventListener('click', () => {
    showModal({
      title: 'Save Theme Preset',
      fields: [{ id: 'name', placeholder: 'e.g. Ocean, Sunset, Work Mode…' }],
      onConfirm: ({ name }) => {
        const preset = { id: `theme_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name, ...uiState.customTheme };
        uiState.customThemes = [...uiState.customThemes, preset];
        window.nexo.setPrefs({ customThemes: uiState.customThemes });
        document.getElementById('preset-list').innerHTML = renderPresetChips();
        wirePresetChips();
        return null;
      },
    });
  });

  function wirePresetChips() {
    document.querySelectorAll('.preset-chip').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        if (e.target.classList.contains('preset-remove')) return;
        const preset = uiState.customThemes.find((p) => p.id === chip.dataset.presetId);
        if (!preset) return;
        uiState.customTheme = { bg: preset.bg, text: preset.text, accent: preset.accent };
        applyTheme('custom');
        document.getElementById('set-custom-bg').value = preset.bg;
        document.getElementById('set-custom-text').value = preset.text;
        document.getElementById('set-custom-accent').value = preset.accent;
        page.querySelectorAll('.settings-theme-card[data-theme-id]').forEach((c) => c.classList.toggle('current', c.dataset.themeId === 'custom'));
      });
    });
    document.querySelectorAll('.preset-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        uiState.customThemes = uiState.customThemes.filter((p) => p.id !== btn.dataset.presetId);
        window.nexo.setPrefs({ customThemes: uiState.customThemes });
        document.getElementById('preset-list').innerHTML = renderPresetChips();
        wirePresetChips();
      });
    });
  }
  wirePresetChips();

  ['bg', 'text', 'accent'].forEach((key) => {
    const input = document.getElementById(`set-custom-${key}`);
    input.addEventListener('input', (e) => {
      uiState.customTheme = { ...uiState.customTheme, [key]: e.target.value };
      applyTheme('custom', { skipSave: true });
      page.querySelectorAll('.settings-theme-card[data-theme-id]').forEach((c) => c.classList.toggle('current', c.dataset.themeId === 'custom'));
    });
    input.addEventListener('change', (e) => {
      uiState.customTheme = { ...uiState.customTheme, [key]: e.target.value };
      applyTheme('custom');
    });
  });

  document.getElementById('set-font-size').addEventListener('change', (e) => {
    const val = Math.max(9, Math.min(28, Number(e.target.value) || 13.5));
    uiState.fontSize = val;
    e.target.value = val;
    applyEditorOptionToBoth({ fontSize: val });
    window.nexo.setPrefs({ fontSize: val });
  });

  const minimapToggle = document.getElementById('set-minimap');
  minimapToggle.addEventListener('click', () => {
    uiState.minimap = !uiState.minimap;
    minimapToggle.classList.toggle('on', uiState.minimap);
    applyEditorOptionToBoth({ minimap: { enabled: uiState.minimap, renderCharacters: false, maxColumn: 80 } });
    window.nexo.setPrefs({ minimap: uiState.minimap });
  });

  const wordWrapToggle = document.getElementById('set-word-wrap');
  wordWrapToggle.addEventListener('click', () => {
    uiState.wordWrap = !uiState.wordWrap;
    wordWrapToggle.classList.toggle('on', uiState.wordWrap);
    applyEditorOptionToBoth({ wordWrap: uiState.wordWrap ? 'on' : 'off' });
    window.nexo.setPrefs({ wordWrap: uiState.wordWrap });
  });

  const autoSaveToggle = document.getElementById('set-autosave');
  autoSaveToggle.addEventListener('click', () => {
    uiState.autoSave = !uiState.autoSave;
    autoSaveToggle.classList.toggle('on', uiState.autoSave);
    window.nexo.setPrefs({ autoSave: uiState.autoSave });
  });

  document.getElementById('set-autosave-delay').addEventListener('change', (e) => {
    const val = Math.max(200, Math.min(10000, Number(e.target.value) || 1000));
    uiState.autoSaveDelayMs = val;
    e.target.value = val;
    window.nexo.setPrefs({ autoSaveDelayMs: val });
  });

  document.getElementById('set-site-interval').addEventListener('change', (e) => {
    const val = Number(e.target.value) || 10;
    uiState.defaultSiteInterval = val;
    window.nexo.setPrefs({ defaultSiteInterval: val });
  });

  document.getElementById('set-custom-shell').addEventListener('change', (e) => {
    uiState.customShell = e.target.value.trim();
    window.nexo.setPrefs({ customShell: uiState.customShell });
  });
}

// ---------------- Theme ----------------
function applyTheme(theme, opts = {}) {
  if (theme === 'custom') {
    uiState.theme = 'custom';
    document.body.dataset.theme = 'custom';
    const vars = buildCustomThemeVars(uiState.customTheme);
    applyCustomThemeVars(vars);
    const btn = document.getElementById('btn-theme-toggle');
    if (btn) btn.textContent = CUSTOM_THEME_META.icon;
    if (monacoLoaded && window.monaco) applyCustomMonacoTheme(vars);
    if (!opts.skipSave) window.nexo.setPrefs({ theme: 'custom', customTheme: uiState.customTheme });
    return;
  }
  clearCustomThemeVars();
  const meta = THEMES.find((t) => t.id === theme) || THEMES[0];
  uiState.theme = meta.id;
  document.body.dataset.theme = meta.id;
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) btn.textContent = meta.icon;
  if (monacoLoaded && window.monaco) {
    monaco.editor.setTheme(meta.monaco);
  }
  if (!opts.skipSave) window.nexo.setPrefs({ theme: meta.id });
}

function toggleThemeDropdown() {
  const dropdown = document.getElementById('theme-dropdown');
  if (!dropdown.classList.contains('hidden')) { dropdown.classList.add('hidden'); return; }
  dropdown.innerHTML = '';
  const allThemes = [...THEMES, { ...CUSTOM_THEME_META, swatch: uiState.customTheme.accent }];
  for (const t of allThemes) {
    const opt = document.createElement('div');
    opt.className = 'theme-option' + (t.id === uiState.theme ? ' current' : '');
    opt.innerHTML = `<span class="swatch" style="background:${t.swatch}"></span><span>${t.label}</span>`;
    opt.addEventListener('click', () => {
      applyTheme(t.id);
      dropdown.classList.add('hidden');
    });
    dropdown.appendChild(opt);
  }
  dropdown.classList.remove('hidden');
}
document.getElementById('btn-theme-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleThemeDropdown();
});
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('theme-dropdown');
  if (!dropdown.classList.contains('hidden') && !dropdown.contains(e.target) && e.target.id !== 'btn-theme-toggle') {
    dropdown.classList.add('hidden');
  }
});

// ---------------- Boot ----------------
// Monaco is a couple MB across many files (asar is disabled for it), so it's
// the slowest thing to load. Load it in the background instead of blocking
// the welcome screen / recent projects / sites list from appearing.
async function boot() {
  // Load saved settings before Monaco initializes so the editor is created
  // with the right theme/font/minimap/wrap from the start instead of
  // flashing or re-applying options after the fact.
  try {
    const prefs = await window.nexo.getPrefs();
    Object.assign(uiState, prefs);
    applyTheme(uiState.theme, { skipSave: true });
  } catch { /* keep defaults */ }

  monacoReadyPromise = new Promise((resolve) => {
    initMonaco(() => { monacoLoaded = true; resolve(); });
  });

  refreshRecent();
  loadSites();
  renderSettingsPage();

  // Tell the main process the UI has actually painted, so it can swap the
  // splash screen for the real window instead of guessing at a timeout.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (window.nexo && window.nexo.notifyReady) window.nexo.notifyReady();
    });
  });
}
boot();
