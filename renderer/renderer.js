/* global monaco, require */

// ---------------- State ----------------
const state = {
  projectRoot: null,
  expanded: new Set(),
  openTabs: [],      // [{path, name, model, viewState, modified, isUntitled}]
  activeTab: null,
  contextTarget: null, // {path, isDirectory} for right-click actions
  showIgnored: false,
  selectedPaths: new Set(), // multi-select in the file tree
};

const uiState = {
  theme: 'dark',
  fontSize: 13.5,
  minimap: true,
  wordWrap: false,
  bracketGuides: false,
  scriptsOrder: [],
  snippets: [],
  autoSave: false,
  autoSaveDelayMs: 1000,
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
      bracketPairColorization: { enabled: uiState.bracketGuides },
      guides: { indentation: uiState.bracketGuides, bracketPairs: uiState.bracketGuides },
      smoothScrolling: false,
      renderWhitespace: 'selection',
      occurrencesHighlight: 'off',
      wordBasedSuggestions: 'currentDocument',
      stickyScroll: { enabled: true },
      mouseWheelZoom: true,
    });

    editor.onDidChangeCursorPosition((e) => {
      document.getElementById('status-pos').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
      saveSessionDebounced();
    });
    addSelectAllAction(editor);
    // Keep our own font-size setting (and Settings page, and prefs.json) in
    // sync no matter how the size changed — our own zoom shortcuts, or
    // Monaco's own Ctrl+scroll-wheel zoom, both land here.
    editor.onDidChangeConfiguration((e) => {
      if (!e.hasChanged(monaco.editor.EditorOption.fontSize)) return;
      const newSize = editor.getOption(monaco.editor.EditorOption.fontSize);
      if (newSize === uiState.fontSize) return;
      uiState.fontSize = newSize;
      if (splitEditor) splitEditor.updateOptions({ fontSize: newSize });
      window.nexo.setPrefs({ fontSize: newSize });
      const fontInput = document.getElementById('set-font-size');
      if (fontInput) fontInput.value = newSize;
    });

    registerSnippetProvider();
    registerBlameHoverProvider();
    cb();
  });
}

// User-defined snippets (Settings → Snippets). Registered once per language
// id we support — Monaco has no true wildcard selector, so 'all'-scoped
// snippets are just filtered into every one of these providers instead.
function registerSnippetProvider() {
  const languageIds = [...new Set(Object.values(LANG_MAP))];
  const provider = {
    triggerCharacters: [],
    provideCompletionItems(model, position) {
      const lang = model.getLanguageId();
      const list = (uiState.snippets || []).filter((s) => s.language === 'all' || s.language === lang);
      if (!list.length) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      return {
        suggestions: list.map((s) => ({
          label: s.prefix,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: s.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: s.description || 'Snippet',
          documentation: s.body,
          range,
          sortText: `0-${s.prefix}`, // float snippets above regular word-based suggestions
        })),
      };
    },
  };
  languageIds.forEach((lang) => monaco.languages.registerCompletionItemProvider(lang, provider));
}

// Inline git blame on hover — one provider registered per language id (same
// constraint as the snippet provider above, Monaco has no wildcard selector).
// Looks up which open tab owns the hovered model, then reads that tab's
// cached blame data rather than fetching per-hover.
function registerBlameHoverProvider() {
  const languageIds = [...new Set(Object.values(LANG_MAP))];
  const provider = {
    provideHover(model, position) {
      const tab = state.openTabs.find((t) => t.model === model);
      if (!tab || !tab.blameLines) return null;
      const info = tab.blameLines[position.lineNumber];
      if (!info) return null;
      if (info.hash === '0000000000000000000000000000000000000000') {
        return {
          range: new monaco.Range(position.lineNumber, 1, position.lineNumber, model.getLineMaxColumn(position.lineNumber)),
          contents: [{ value: '**Uncommitted change**' }],
        };
      }
      const dateStr = info.time ? new Date(info.time * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
      return {
        range: new monaco.Range(position.lineNumber, 1, position.lineNumber, model.getLineMaxColumn(position.lineNumber)),
        contents: [
          { value: `**${info.author}** · ${dateStr}` },
          { value: info.summary || '' },
          { value: `\`${info.hash.slice(0, 7)}\`` },
        ],
      };
    },
  };
  languageIds.forEach((lang) => monaco.languages.registerHoverProvider(lang, provider));
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
    bracketPairColorization: { enabled: uiState.bracketGuides && !isLarge },
    guides: { indentation: uiState.bracketGuides && !isLarge, bracketPairs: uiState.bracketGuides && !isLarge },
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
  paletteState.filesCache = null;
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
// ---------------- Breadcrumb bar ----------------
function renderBreadcrumb() {
  const bar = document.getElementById('breadcrumb-bar');
  if (!state.activeTab || !state.projectRoot) { bar.innerHTML = ''; bar.classList.remove('active'); return; }
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
  bar.innerHTML = segs.join('');
  bar.classList.add('active');
  bar.querySelectorAll('.crumb:not(.crumb-file)').forEach((el) => {
    el.addEventListener('click', () => revealInTree(el.dataset.path));
  });
}

async function revealInTree(folderPath) {
  let p = folderPath;
  const toExpand = [];
  while (p && p !== state.projectRoot && p.length > state.projectRoot.length) {
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
    if (myToken === treeRenderToken) container.innerHTML = '';
    return;
  }
  visibleRowOrder = [];
  const rootNode = await buildNode(state.projectRoot, true);
  if (myToken !== treeRenderToken) return; // a newer render started — discard this one
  container.innerHTML = '';
  container.appendChild(rootNode);
}

function isIgnoredEntry(entry) {
  if (state.showIgnored || !gitState.ignoredPaths.size) return false;
  const rel = relToGitRoot(entry.path);
  if (rel == null) return false;
  if (gitState.ignoredPaths.has(rel)) return true;
  if (entry.isDirectory && gitState.ignoredPaths.has(rel + '/')) return true;
  return false;
}

async function buildNode(nodePath, isRoot = false) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';

  const entries = (await window.nexo.readDir(nodePath)).filter((e) => !isIgnoredEntry(e));
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
let visibleRowOrder = [];

async function renderEntry(entry) {
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
      const children = (await window.nexo.readDir(entry.path)).filter((e) => !isIgnoredEntry(e));
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
document.getElementById('file-tree').addEventListener('contextmenu', (e) => {
  if (e.target.id === 'file-tree') {
    e.preventDefault();
    state.selectedPaths.clear();
    state.contextTarget = { path: state.projectRoot, isDirectory: true };
    showContextMenu(e.clientX, e.clientY, true);
  }
});
document.getElementById('file-tree').addEventListener('click', (e) => {
  if (e.target.id === 'file-tree' && state.selectedPaths.size) {
    state.selectedPaths.clear();
    renderTree();
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
async function openFile(filePath, opts = {}) {
  if (!monacoLoaded) {
    document.getElementById('status-path').textContent = 'Loading editor…';
    await monacoReadyPromise;
  }
  let tab = state.openTabs.find((t) => t.path === filePath);
  if (!tab) {
    const res = await window.nexo.readFile(filePath);
    if (!res.ok) {
      if (!opts.silent) alert(`Could not open file:\n${res.error}`);
      return false;
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
      if (t && state.activeTab === filePath) scheduleOutlineRefresh();
      if (t) scheduleLint(filePath);
    });
    tab = { path: filePath, name, model, modified: false, byteLength: res.content.length, isMarkdown, mdMode: isMarkdown ? 'preview' : null, pinned: false };
    state.openTabs.push(tab);
    if (splitState.visible) updateSplitTabOptions();
    window.nexo.watchFile(filePath);
  }
  if (!opts.skipActivate) activateTab(filePath);
  if (!opts.silent) renderTree();
  return true;
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
  if (tab.pendingCursor) {
    editor.setPosition({ lineNumber: tab.pendingCursor.line, column: tab.pendingCursor.column });
    editor.revealPositionInCenter({ lineNumber: tab.pendingCursor.line, column: tab.pendingCursor.column });
    delete tab.pendingCursor;
  }
  document.getElementById('status-path').textContent = filePath;
  document.getElementById('status-lang').textContent = tab.model.getModeId ? tab.model.getModeId() : '';
  renderTabs();
  renderTree();
  renderBreadcrumb();

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
  refreshOutlineIfVisible();
  lintFile(filePath);
  refreshBlameForTab(filePath);
}

let draggedTabPath = null;
function renderTabs() {
  const bar = document.getElementById('tabbar');
  bar.innerHTML = '';
  const ordered = [...state.openTabs].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  for (const tab of ordered) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.path === state.activeTab ? ' active' : '') + (tab.modified ? ' modified' : '') + (tab.pinned ? ' pinned' : '');
    el.draggable = true;
    el.innerHTML = `<span class="tab-pin ${tab.pinned ? 'pinned' : ''}" title="${tab.pinned ? 'Unpin' : 'Pin'} tab">📌</span><span class="dot"></span><span class="name">${escapeHtml(tab.name)}</span><span class="split-open" title="Open in split view">⧉</span><span class="close" title="Close">✕</span>`;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('close')) { closeTab(tab.path); return; }
      if (e.target.classList.contains('split-open')) { openInSplit(tab.path); return; }
      if (e.target.classList.contains('tab-pin')) { tab.pinned = !tab.pinned; renderTabs(); return; }
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
    bar.appendChild(el);
  }
  saveSessionDebounced();
}

function captureTabCursor(tab) {
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

let sessionSaveTimer = null;
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

const closedTabsStack = [];
function reopenClosedTab() {
  const p = closedTabsStack.pop();
  if (p) openFile(p);
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

  window.nexo.unwatchFile(filePath);
  closedTabsStack.push(filePath);
  if (closedTabsStack.length > 20) closedTabsStack.shift();

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
      renderBreadcrumb();
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
      const raw = marked.parse(tab.model.getValue());
      box.innerHTML = window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
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
    if (scanConflicts(tab.model).length) return; // don't silently persist unresolved conflict markers
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
  if (scanConflicts(tab.model).length) {
    const proceed = confirm('This file still has unresolved merge conflict markers (<<<<<<< / ======= / >>>>>>>).\n\nSave anyway?');
    if (!proceed) return;
  }
  const res = await window.nexo.writeFile(tab.path, tab.model.getValue());
  if (!res.ok) { alert(`Could not save file:\n${res.error}`); return; }
  tab.modified = false;
  renderTabs();
  lintFile(tab.path);
  refreshBlameForTab(tab.path);
}

async function saveActiveTabAs() {
  if (!state.activeTab) return;
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (!tab) return;
  if (scanConflicts(tab.model).length) {
    const proceed = confirm('This file still has unresolved merge conflict markers (<<<<<<< / ======= / >>>>>>>).\n\nSave anyway?');
    if (!proceed) return;
  }
  const newPath = await window.nexo.saveAsDialog(tab.name);
  if (!newPath) return;
  const res = await window.nexo.writeFile(newPath, tab.model.getValue());
  if (!res.ok) { alert(`Could not save file:\n${res.error}`); return; }
  await openFile(newPath);
  renderTree();
}

// ---------------- Context menu ----------------
function copyPathsToClipboard(paths, relative) {
  const text = paths.map((p) => {
    if (!relative || !state.projectRoot) return p;
    return p.startsWith(state.projectRoot) ? p.slice(state.projectRoot.length + 1) : p;
  }).join('\n');
  navigator.clipboard.writeText(text).catch(() => {});
}

async function addToGitignore(targetPath, isDir) {
  if (!state.projectRoot) return;
  let rel = targetPath.startsWith(state.projectRoot) ? targetPath.slice(state.projectRoot.length + 1) : targetPath;
  rel = rel.replace(/\\/g, '/');
  if (isDir) rel += '/';
  const sep = state.projectRoot.includes('\\') ? '\\' : '/';
  const gitignorePath = state.projectRoot + sep + '.gitignore';
  const res = await window.nexo.readFile(gitignorePath);
  let content = res.ok ? res.content : '';
  const lines = content.split(/\r?\n/);
  if (lines.some((l) => l.trim() === rel)) { flashToast(`${rel} is already in .gitignore`); return; }
  if (content.length && !content.endsWith('\n')) content += '\n';
  content += rel + '\n';
  const writeRes = await window.nexo.writeFile(gitignorePath, content);
  if (!writeRes.ok) { flashToast(`Could not update .gitignore: ${writeRes.error || 'unknown error'}`); return; }
  flashToast(`Added ${rel} to .gitignore`);
  const tab = state.openTabs.find((t) => t.path === gitignorePath);
  if (tab) tab.model.setValue(content);
  if (document.getElementById('panel-git').classList.contains('active')) refreshGitStatus();
  renderTree();
}

async function confirmBulkDelete(paths) {
  const ok = confirm(`Delete ${paths.length} selected items? This cannot be undone.`);
  if (!ok) return;
  for (const p of paths) {
    await window.nexo.deleteItem(p);
    const toClose = state.openTabs.filter((t) => t.path === p || t.path.startsWith(p + '/') || t.path.startsWith(p + '\\'));
    for (const t of toClose) { t.modified = false; closeTab(t.path); }
  }
  state.selectedPaths.clear();
  await renderTree();
}

function showContextMenu(x, y, isDirectory) {
  const menu = document.getElementById('context-menu');
  const items = [];
  const multiCount = state.selectedPaths.size;

  if (multiCount >= 2) {
    const paths = [...state.selectedPaths];
    items.push({ label: `Delete ${multiCount} Items`, danger: true, action: () => confirmBulkDelete(paths) });
    items.push({ sep: true });
    items.push({ label: 'Copy Paths', action: () => copyPathsToClipboard(paths, false) });
    items.push({ label: 'Copy Relative Paths', action: () => copyPathsToClipboard(paths, true) });
  } else {
    if (isDirectory) {
      items.push({ label: 'New File', action: () => promptNewFile(state.contextTarget.path) });
      items.push({ label: 'New Folder', action: () => promptNewFolder(state.contextTarget.path) });
      items.push({ sep: true });
    }
    items.push({ label: 'Copy Path', action: () => copyPathsToClipboard([state.contextTarget.path], false) });
    items.push({ label: 'Copy Relative Path', action: () => copyPathsToClipboard([state.contextTarget.path], true) });
    items.push({ sep: true });
    if (state.contextTarget.path !== state.projectRoot) {
      items.push({ label: 'Rename', action: () => promptRename(state.contextTarget.path) });
      items.push({ label: 'Reveal in Explorer', action: () => window.nexo.revealInFolder(state.contextTarget.path) });
      items.push({ label: 'Add to .gitignore', action: () => addToGitignore(state.contextTarget.path, isDirectory) });
      items.push({ sep: true });
      items.push({ label: 'Delete', danger: true, action: () => confirmDelete(state.contextTarget.path, isDirectory) });
    } else {
      items.push({ label: 'Reveal in Explorer', action: () => window.nexo.revealInFolder(state.contextTarget.path) });
    }
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
    bracketPairColorization: { enabled: uiState.bracketGuides },
    guides: { indentation: uiState.bracketGuides, bracketPairs: uiState.bracketGuides },
    smoothScrolling: false,
    renderWhitespace: 'selection',
    occurrencesHighlight: 'off',
    wordBasedSuggestions: 'currentDocument',
    stickyScroll: { enabled: true },
    mouseWheelZoom: true,
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
    if (window.marked) {
      const raw = marked.parse(tab.model.getValue());
      box.innerHTML = window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
    } else {
      box.innerHTML = '<p>Markdown renderer not available. Run <code>npm install</code> and restart.</p>';
    }
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

// ---------------- Multiple terminal sessions ----------------
let terminals = [];
let activeTerminalId = null;
let nextTerminalNum = 1;

function createTerminalSession() {
  const id = 'term-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const outputEl = document.createElement('div');
  outputEl.className = 'term-session-output';
  document.getElementById('terminal-output').appendChild(outputEl);
  const session = {
    id,
    title: `Terminal ${nextTerminalNum++}`,
    activeRunId: null,
    runningScript: null,
    history: [],
    historyIdx: -1,
    ansiBuffer: '',
    ansiState: { fg: null, bg: null, bold: false, italic: false, underline: false },
    outputEl,
  };
  terminals.push(session);
  return session;
}

function getActiveTerminal() {
  return terminals.find((t) => t.id === activeTerminalId) || null;
}

function findTerminalByRunId(id) {
  return terminals.find((t) => t.activeRunId === id) || null;
}

function switchTerminalTab(id) {
  activeTerminalId = id;
  terminals.forEach((t) => t.outputEl.classList.toggle('active', t.id === id));
  renderTerminalTabs();
  const t = getActiveTerminal();
  document.getElementById('term-run-btn').textContent = t && t.activeRunId ? 'Stop' : 'Run';
  document.getElementById('terminal-input').focus();
}

function closeTerminalTab(id) {
  const t = terminals.find((x) => x.id === id);
  if (!t) return;
  if (t.activeRunId) window.nexo.killCommand(t.activeRunId);
  t.outputEl.remove();
  terminals = terminals.filter((x) => x.id !== id);
  if (activeTerminalId === id) {
    const next = terminals[terminals.length - 1];
    if (next) switchTerminalTab(next.id);
    else { activeTerminalId = null; ensureTerminalSession(); }
  } else {
    renderTerminalTabs();
  }
}

function ensureTerminalSession() {
  if (!terminals.length) {
    const t = createTerminalSession();
    switchTerminalTab(t.id);
  } else if (!activeTerminalId) {
    switchTerminalTab(terminals[0].id);
  }
}

function renderTerminalTabs() {
  const bar = document.getElementById('terminal-tabs');
  bar.innerHTML = '';
  terminals.forEach((t) => {
    const el = document.createElement('div');
    el.className = 'term-tab' + (t.id === activeTerminalId ? ' active' : '') + (t.activeRunId ? ' running' : '');
    el.innerHTML = `<span class="term-tab-dot"></span><span class="term-tab-name">${escapeHtml(t.title)}</span><span class="term-tab-close" title="Close">✕</span>`;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('term-tab-close')) { closeTerminalTab(t.id); return; }
      switchTerminalTab(t.id);
    });
    bar.appendChild(el);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'term-tab-add';
  addBtn.title = 'New Terminal';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', () => { const t = createTerminalSession(); switchTerminalTab(t.id); });
  bar.appendChild(addBtn);
}

function termAppend(session, text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  session.outputEl.appendChild(span);
  session.outputEl.scrollTop = session.outputEl.scrollHeight;
}

// ---------------- ANSI color rendering ----------------
const ANSI_PALETTE = {
  30: '#1c1c22', 31: '#f0526b', 32: '#3ecf8e', 33: '#e6b83c', 34: '#3b82f6', 35: '#c084fc', 36: '#22d3ee', 37: '#d4d4d8',
  90: '#6e6e78', 91: '#ff7a90', 92: '#6ee7a8', 93: '#f2cc6b', 94: '#60a5fa', 95: '#d8b4fe', 96: '#67e8f9', 97: '#f5f5f7',
};
function ansi256ToHex(n) {
  if (n < 16) {
    const base = [
      '#1c1c22', '#f0526b', '#3ecf8e', '#e6b83c', '#3b82f6', '#c084fc', '#22d3ee', '#d4d4d8',
      '#6e6e78', '#ff7a90', '#6ee7a8', '#f2cc6b', '#60a5fa', '#d8b4fe', '#67e8f9', '#f5f5f7',
    ];
    return base[n];
  }
  if (n <= 231) {
    const i = n - 16;
    const level = (v) => (v === 0 ? 0 : 55 + v * 40);
    return rgbToHex({ r: level(Math.floor(i / 36)), g: level(Math.floor((i % 36) / 6)), b: level(i % 6) });
  }
  const gray = 8 + (n - 232) * 10;
  return rgbToHex({ r: gray, g: gray, b: gray });
}

function resetAnsiState(session) {
  session.ansiBuffer = '';
  session.ansiState = { fg: null, bg: null, bold: false, italic: false, underline: false };
}

function applySgrCodes(session, codes) {
  const s = session.ansiState;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) { session.ansiState = { fg: null, bg: null, bold: false, italic: false, underline: false }; }
    else if (code === 1) s.bold = true;
    else if (code === 3) s.italic = true;
    else if (code === 4) s.underline = true;
    else if (code === 22) s.bold = false;
    else if (code === 23) s.italic = false;
    else if (code === 24) s.underline = false;
    else if (code === 39) s.fg = null;
    else if (code === 49) s.bg = null;
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) s.fg = ANSI_PALETTE[code];
    else if (code >= 40 && code <= 47) s.bg = ANSI_PALETTE[code - 10];
    else if (code >= 100 && code <= 107) s.bg = ANSI_PALETTE[code - 10];
    else if (code === 38 || code === 48) {
      const target = code === 38 ? 'fg' : 'bg';
      const mode = codes[i + 1];
      if (mode === 5) { s[target] = ansi256ToHex(codes[i + 2]); i += 2; }
      else if (mode === 2) { s[target] = rgbToHex({ r: codes[i + 2], g: codes[i + 3], b: codes[i + 4] }); i += 4; }
    }
  }
}

function appendAnsiText(session, frag, str) {
  if (!str) return;
  const s = session.ansiState;
  const span = document.createElement('span');
  const styleParts = [];
  if (s.fg) styleParts.push(`color:${s.fg}`);
  if (s.bg) styleParts.push(`background-color:${s.bg}`);
  if (s.bold) styleParts.push('font-weight:700');
  if (s.italic) styleParts.push('font-style:italic');
  if (s.underline) styleParts.push('text-decoration:underline');
  if (styleParts.length) span.setAttribute('style', styleParts.join(';'));
  span.textContent = str;
  frag.appendChild(span);
}

// Process output be terminal-style ANSI (colors, bold, etc.) instead of the
// raw escape codes. Process output can split a sequence — or a line —
// across multiple data chunks, so an incomplete trailing escape sequence is
// held back and prepended to the next chunk rather than dropped/garbled.
function termAppendAnsi(session, chunk) {
  let text = session.ansiBuffer + chunk;
  session.ansiBuffer = '';
  const incomplete = text.match(/\x1b\[[0-9;]*$/);
  if (incomplete) {
    session.ansiBuffer = incomplete[0];
    text = text.slice(0, -session.ansiBuffer.length);
  }

  const frag = document.createDocumentFragment();
  const re = /\x1b\[([0-9;]*)([a-zA-Z])/g;
  let lastIndex = 0;
  let match;
  while ((match = re.exec(text))) {
    if (match.index > lastIndex) appendAnsiText(session, frag, text.slice(lastIndex, match.index));
    if (match[2] === 'm') {
      const codes = match[1].length ? match[1].split(';').map((c) => (c === '' ? 0 : parseInt(c, 10))) : [0];
      applySgrCodes(session, codes);
    }
    // Non-color codes (cursor movement, clear line, etc.) are silently dropped —
    // there's no real terminal cursor here, just an append-only log.
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) appendAnsiText(session, frag, text.slice(lastIndex));
  session.outputEl.appendChild(frag);
  session.outputEl.scrollTop = session.outputEl.scrollHeight;
}

function toggleTerminal(forceShow) {
  const panel = document.getElementById('terminal-panel');
  const show = forceShow !== undefined ? forceShow : !panel.classList.contains('active');
  panel.classList.toggle('active', show);
  document.getElementById('terminal-cwd').textContent = state.projectRoot ? `— ${state.projectRoot}` : '';
  if (show) {
    ensureTerminalSession();
    document.getElementById('terminal-input').focus();
  }
  if (editor) editor.layout();
}

function toggleZenMode(forceOn) {
  const on = forceOn !== undefined ? forceOn : !document.body.classList.contains('zen-mode');
  document.body.classList.toggle('zen-mode', on);
  if (on) toggleTerminal(false); // start distraction-free with the terminal closed too
  if (editor) editor.layout();
  if (splitEditor) splitEditor.layout();
}

async function runTerminalCommand() {
  const input = document.getElementById('terminal-input');
  const cmd = input.value.trim();
  if (!cmd) return;
  const t = getActiveTerminal();
  if (!t) return;
  if (!state.projectRoot) { termAppend(t, 'Open a folder first — commands run in the project root.\n', 'term-err'); return; }
  if (t.activeRunId) return; // one command at a time per tab; use Stop first, or open another tab

  t.history.push(cmd);
  t.historyIdx = t.history.length;
  resetAnsiState(t);
  termAppend(t, `\n$ ${cmd}\n`, 'term-cmd');
  input.value = '';

  const res = await window.nexo.runCommand(state.projectRoot, cmd);
  if (!res.id) {
    termAppend(t, `[error] ${res.error || 'Could not start command.'}\n`, 'term-err');
    return;
  }
  t.activeRunId = res.id;
  if (t.id === activeTerminalId) document.getElementById('term-run-btn').textContent = 'Stop';
  renderTerminalTabs();
}

async function stopTerminalCommand() {
  const t = getActiveTerminal();
  if (!t || !t.activeRunId) return;
  await window.nexo.killCommand(t.activeRunId);
}

window.nexo.onTermData((id, chunk) => {
  const t = findTerminalByRunId(id);
  if (!t) return;
  termAppendAnsi(t, chunk);
});
window.nexo.onTermExit((id, code) => {
  const t = findTerminalByRunId(id);
  if (!t) return;
  termAppend(t, `[exited with code ${code}]\n`, 'term-exit');
  t.activeRunId = null;
  t.runningScript = null;
  if (t.id === activeTerminalId) document.getElementById('term-run-btn').textContent = 'Run';
  renderTerminalTabs();
  renderScriptsPanel();
});

document.getElementById('term-run-btn').addEventListener('click', () => {
  const t = getActiveTerminal();
  if (t && t.activeRunId) stopTerminalCommand();
  else runTerminalCommand();
});
document.getElementById('terminal-input').addEventListener('keydown', (e) => {
  const t = getActiveTerminal();
  if (!t) return;
  if (e.key === 'Enter') { e.preventDefault(); runTerminalCommand(); return; }
  if (e.key === 'ArrowUp') {
    if (t.historyIdx > 0) { t.historyIdx--; e.target.value = t.history[t.historyIdx]; }
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowDown') {
    if (t.historyIdx < t.history.length - 1) {
      t.historyIdx++;
      e.target.value = t.history[t.historyIdx];
    } else {
      t.historyIdx = t.history.length;
      e.target.value = '';
    }
    e.preventDefault();
  }
});
document.getElementById('term-clear').addEventListener('click', () => {
  const t = getActiveTerminal();
  if (!t) return;
  t.outputEl.innerHTML = '';
  resetAnsiState(t);
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

function handleCloneRepo() {
  showModal({
    title: 'Clone Repository',
    fields: [{ id: 'url', placeholder: 'https://github.com/user/repo.git' }],
    confirmLabel: 'Next',
    onConfirm: ({ url }) => {
      // Deferred so the destination-folder dialog doesn't pop up stacked on
      // top of this modal while it's still closing.
      setTimeout(() => continueCloneFlow(url.trim()), 50);
      return null;
    },
  });
}

async function continueCloneFlow(url) {
  if (openInProgress) return;
  const parent = await window.nexo.pickFolder('Choose where to clone this repository');
  if (!parent) return;
  openInProgress = true;
  showUpdateToast('Cloning repository…', []);
  try {
    const res = await window.nexo.cloneRepo(url, parent);
    hideUpdateToast();
    if (!res.ok) { alert(`Clone failed:\n${res.error}`); return; }
    await openProject(res.path);
  } finally {
    openInProgress = false;
  }
}

document.getElementById('btn-open-folder').addEventListener('click', handleOpenFolder);
document.getElementById('welcome-open').addEventListener('click', handleOpenFolder);
document.getElementById('welcome-new').addEventListener('click', handleNewProject);
document.getElementById('welcome-clone').addEventListener('click', handleCloneRepo);
document.getElementById('welcome-github-repos').addEventListener('click', openGithubRepoPicker);
document.getElementById('welcome-github-create').addEventListener('click', handleCreateGithubRepo);

function openGithubRepoPicker() {
  paletteState.githubRepos = null; // force a fresh fetch each time
  openPalette('github-repos');
}

function handleCreateGithubRepo() {
  window.nexo.hasGithubToken().then((status) => {
    if (!status.hasToken) { alert('Connect a GitHub token in Settings first.'); return; }
    showModal({
      title: 'Create GitHub Repository',
      fields: [
        { id: 'name', placeholder: 'my-new-repo' },
        { id: 'description', placeholder: 'Description (optional)', required: false },
      ],
      confirmLabel: 'Next',
      onConfirm: ({ name, description }) => {
        if (!name.trim()) return 'Repository name is required.';
        setTimeout(() => continueCreateGithubRepoFlow(name.trim(), description.trim()), 50);
        return null;
      },
    });
  });
}

async function continueCreateGithubRepoFlow(name, description) {
  const isPrivate = confirm('Make this repository private?\n\nOK = private, Cancel = public');
  showUpdateToast('Creating repository…', []);
  const res = await window.nexo.createGithubRepo({ name, description, isPrivate });
  hideUpdateToast();
  if (!res.ok) { alert(`Could not create repository:\n${res.error}`); return; }
  const cloneNow = confirm(`Created ${res.repo.fullName} on GitHub.\n\nClone it locally now?`);
  if (cloneNow) continueCloneFlow(res.repo.cloneUrl);
}
document.getElementById('btn-new-file').addEventListener('click', handleNewFile);
document.getElementById('btn-add-file').addEventListener('click', () => state.projectRoot && promptNewFile(state.projectRoot));
document.getElementById('btn-add-folder').addEventListener('click', () => state.projectRoot && promptNewFolder(state.projectRoot));
document.getElementById('btn-toggle-ignored').addEventListener('click', async () => {
  state.showIgnored = !state.showIgnored;
  document.getElementById('btn-toggle-ignored').classList.toggle('on', state.showIgnored);
  document.getElementById('btn-toggle-ignored').title = state.showIgnored
    ? 'Hide files matched by .gitignore'
    : 'Show files matched by .gitignore';
  await refreshIgnoredPaths();
  await renderTree();
});

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
  if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); changeFontSize(1); }
  if (ctrl && e.key === '-') { e.preventDefault(); changeFontSize(-1); }
  if (ctrl && e.key === '0') { e.preventDefault(); resetFontSize(); }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); reopenClosedTab(); }
  if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openPalette('files'); }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openPalette('commands'); }
  if (e.key === 'Escape' && document.body.classList.contains('zen-mode')) { toggleZenMode(false); }
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
  window.nexo.onMenu('menu:toggle-zen', () => toggleZenMode());
  window.nexo.onMenu('menu:toggle-sidebar', () => {
    const sb = document.getElementById('sidebar');
    sb.style.display = sb.style.display === 'none' ? 'flex' : 'none';
  });
}

if (window.nexo.onFileChanged) {
  window.nexo.onFileChanged(async (filePath) => {
    const tab = state.openTabs.find((t) => t.path === filePath);
    if (!tab) return; // not open anymore (or watcher hadn't been stopped yet)
    if (tab.modified) {
      const reload = confirm(`"${tab.name}" changed on disk (outside Nexo Dev).\n\nYou have unsaved changes here. Reload from disk and lose them, or keep your version?`);
      if (!reload) return;
    }
    const res = await window.nexo.readFile(filePath);
    if (!res.ok) return;
    const viewState = (editor && editor.getModel() === tab.model) ? editor.saveViewState() : null;
    tab.model.setValue(res.content);
    tab.byteLength = res.content.length;
    tab.modified = false;
    renderTabs();
    if (viewState && editor) editor.restoreViewState(viewState);
    if (tab.isMarkdown && tab.mdMode === 'preview') renderMarkdownPreview(tab);
  });
}

// ---------------- Auto-update ----------------
function showUpdateToast(text, actions) {
  const toast = document.getElementById('update-toast');
  document.getElementById('update-toast-text').textContent = text;
  const actionsBox = document.getElementById('update-toast-actions');
  actionsBox.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement('button');
    if (a.primary) btn.className = 'primary';
    btn.textContent = a.label;
    btn.addEventListener('click', a.onClick);
    actionsBox.appendChild(btn);
  }
  toast.classList.remove('hidden');
}
function hideUpdateToast() { document.getElementById('update-toast').classList.add('hidden'); }

let flashToastTimer = null;
function flashToast(text) {
  showUpdateToast(text, [{ label: 'Dismiss', onClick: hideUpdateToast }]);
  clearTimeout(flashToastTimer);
  flashToastTimer = setTimeout(hideUpdateToast, 4000);
}

if (window.nexo.onUpdateAvailable) {
  window.nexo.onUpdateAvailable((version) => {
    showUpdateToast(`Nexo Dev ${version} is available.`, [
      { label: 'Download', primary: true, onClick: () => {
        window.nexo.downloadUpdate();
        showUpdateToast('Downloading update… 0%', []);
      } },
      { label: 'Dismiss', onClick: hideUpdateToast },
    ]);
  });
}
if (window.nexo.onUpdateNotAvailable) {
  window.nexo.onUpdateNotAvailable(() => {
    showUpdateToast("You're on the latest version.", [{ label: 'OK', primary: true, onClick: hideUpdateToast }]);
  });
}
if (window.nexo.onUpdateProgress) {
  window.nexo.onUpdateProgress((percent) => {
    showUpdateToast(`Downloading update… ${Math.round(percent)}%`, []);
  });
}
if (window.nexo.onUpdateDownloaded) {
  window.nexo.onUpdateDownloaded(() => {
    showUpdateToast('Update downloaded. Restart to install it.', [
      { label: 'Restart Now', primary: true, onClick: () => window.nexo.installUpdate() },
      { label: 'Later', onClick: hideUpdateToast },
    ]);
  });
}
if (window.nexo.onUpdateError) {
  window.nexo.onUpdateError((message) => {
    showUpdateToast(`Update check failed: ${message}`, [{ label: 'OK', primary: true, onClick: hideUpdateToast }]);
  });
}
if (window.nexo.onMenu) {
  window.nexo.onMenu('menu:check-updates', () => window.nexo.checkForUpdates(true));
}

window.addEventListener('beforeunload', (e) => {
  const dirty = state.openTabs.some((t) => t.modified);
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------- Global search ----------------
let searchDebounceTimer = null;
function validateSearchRegex() {
  const useRegex = document.getElementById('search-regex').checked;
  const errBox = document.getElementById('search-regex-error');
  if (!useRegex) { errBox.classList.add('hidden'); return true; }
  const query = document.getElementById('search-input').value;
  if (!query) { errBox.classList.add('hidden'); return true; }
  try {
    new RegExp(query);
    errBox.classList.add('hidden');
    return true;
  } catch (err) {
    errBox.textContent = `Invalid regex: ${err.message}`;
    errBox.classList.remove('hidden');
    return false;
  }
}

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
  if (!validateSearchRegex()) {
    summary.textContent = '';
    results.innerHTML = '';
    return;
  }
  summary.textContent = 'Searching…';
  const caseSensitive = document.getElementById('search-case').checked;
  const useRegex = document.getElementById('search-regex').checked;
  const res = await window.nexo.searchText(state.projectRoot, query, { caseSensitive, useRegex });
  if (res.error) {
    summary.textContent = '';
    results.innerHTML = '';
    const errBox = document.getElementById('search-regex-error');
    errBox.textContent = `Invalid regex: ${res.error}`;
    errBox.classList.remove('hidden');
    return;
  }
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
  validateSearchRegex();
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(runSearch, 300);
});
document.getElementById('search-case').addEventListener('change', runSearch);
document.getElementById('search-regex').addEventListener('change', () => { validateSearchRegex(); runSearch(); });

document.getElementById('btn-toggle-replace').addEventListener('click', (e) => {
  const row = document.getElementById('replace-row');
  const show = row.classList.contains('hidden');
  row.classList.toggle('hidden', !show);
  e.currentTarget.classList.toggle('on', show);
  if (show) document.getElementById('replace-input').focus();
});

document.getElementById('btn-replace-all').addEventListener('click', async () => {
  const query = document.getElementById('search-input').value;
  const replacement = document.getElementById('replace-input').value;
  if (!query.trim()) return;
  if (!state.projectRoot) { alert('Open a folder first.'); return; }
  if (!validateSearchRegex()) return;
  const caseSensitive = document.getElementById('search-case').checked;
  const useRegex = document.getElementById('search-regex').checked;

  const ok = confirm(`Replace all occurrences of "${query}" with "${replacement}" across the project?\n\nThis rewrites matching files directly — it cannot be undone by this app (though your own version control can still help if the project is a git repo).`);
  if (!ok) return;

  const btn = document.getElementById('btn-replace-all');
  btn.disabled = true;
  btn.textContent = 'Replacing…';
  const res = await window.nexo.replaceAll(state.projectRoot, query, replacement, { caseSensitive, useRegex });
  btn.disabled = false;
  btn.textContent = 'Replace All';

  if (res.errors.length && res.filesChanged === 0 && res.totalReplacements === 0 && res.errors[0].path === '') {
    const errBox = document.getElementById('search-regex-error');
    errBox.textContent = res.errors[0].error;
    errBox.classList.remove('hidden');
    return;
  }

  document.getElementById('search-summary').textContent =
    `Replaced ${res.totalReplacements} occurrence${res.totalReplacements === 1 ? '' : 's'} in ${res.filesChanged} file${res.filesChanged === 1 ? '' : 's'}` +
    (res.errors.length ? ` (${res.errors.length} failed)` : '');
  document.getElementById('search-results').innerHTML = '';

  // Any changed files that happen to be open need their editor content
  // refreshed — reuse the same silent-reload path as external file changes,
  // since that's exactly what this is (the disk content just changed).
  for (const p of res.changedPaths) {
    const tab = state.openTabs.find((t) => t.path === p);
    if (!tab) continue;
    const fresh = await window.nexo.readFile(p);
    if (!fresh.ok) continue;
    const isActiveModel = editor && editor.getModel() === tab.model;
    const viewState = isActiveModel ? editor.saveViewState() : null;
    tab.model.setValue(fresh.content);
    tab.byteLength = fresh.content.length;
    tab.modified = false;
    if (isActiveModel && viewState) editor.restoreViewState(viewState);
    if (tab.isMarkdown && tab.mdMode === 'preview') renderMarkdownPreview(tab);
  }
  if (res.changedPaths.length) renderTabs();
});

// ---------------- Git / Source Control ----------------
const gitState = { root: null, staged: [], unstaged: [], conflicts: [], available: false, activePath: null, activeStaged: false, activeCommit: null, subtab: 'changes', ignoredPaths: new Set() };

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

let gitStatusToken = 0;
async function refreshGitStatus() {
  const myToken = ++gitStatusToken;
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
  if (myToken !== gitStatusToken) return; // a newer refresh started while this one was in flight — discard
  if (!res.ok) {
    gitState.available = false;
    gitState.ignoredPaths = new Set();
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
  const stillWorkingTimer = setTimeout(() => { btn.textContent = '⬆ Still working…'; }, 5000);
  const res = await window.nexo.gitPush(state.projectRoot);
  clearTimeout(stillWorkingTimer);
  btn.textContent = '⬆ Push';
  btn.disabled = false;
  if (!res.ok) { alert(`Push failed:\n${res.error}`); return; }
  refreshRemoteStatus();
}

async function gitPullFlow() {
  const btn = document.getElementById('git-pull-btn');
  btn.disabled = true;
  btn.textContent = '⬇ Pulling…';
  const stillWorkingTimer = setTimeout(() => { btn.textContent = '⬇ Still working…'; }, 5000);
  const res = await window.nexo.gitPull(state.projectRoot);
  clearTimeout(stillWorkingTimer);
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
      body.appendChild(t);
      for (const entry of gitState.staged) body.appendChild(renderGitFileRow(entry, true));
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
      body.appendChild(t);
      for (const entry of gitState.unstaged) body.appendChild(renderGitFileRow(entry, false));
    }
  }

  const commitBox = document.createElement('div');
  commitBox.id = 'git-commit-box';
  commitBox.innerHTML = `
    <textarea id="git-commit-msg" placeholder="Commit message…"></textarea>
    <button id="git-commit-btn" ${gitState.staged.length ? '' : 'disabled title="Stage at least one file to enable committing"'}>Commit ${gitState.staged.length ? `(${gitState.staged.length})` : ''}</button>
  `;
  body.appendChild(commitBox);
  document.getElementById('git-commit-btn').addEventListener('click', async () => {
    const msgBox = document.getElementById('git-commit-msg');
    const msg = msgBox.value.trim();
    if (!msg) { msgBox.focus(); msgBox.classList.add('shake'); setTimeout(() => msgBox.classList.remove('shake'), 400); return; }
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
      const res = await window.nexo.gitUnstage(state.projectRoot, entry.path);
      if (!res.ok) { alert(`Could not unstage "${entry.path}":\n${res.error || 'unknown error'}`); }
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
      const res = await window.nexo.gitStage(state.projectRoot, entry.path);
      if (!res.ok) { alert(`Could not stage "${entry.path}":\n${res.error || 'unknown error'}`); }
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
        const res = await window.nexo.gitDiscard(state.projectRoot, entry.path);
        if (!res.ok) { alert(`Could not discard changes to "${entry.path}":\n${res.error || 'unknown error'}`); }
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
    const res = await window.nexo.gitStage(state.projectRoot, entry.path);
    if (!res.ok) { alert(`Could not mark "${entry.path}" resolved:\n${res.error || 'unknown error'}`); }
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
  document.getElementById('breadcrumb-bar').classList.remove('active');

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
  document.getElementById('breadcrumb-bar').classList.remove('active');

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
const FULL_WORKSPACES = { settings: 'workspace-settings' };

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
  if (view === 'scripts') loadScripts();
  if (view === 'outline') renderOutlinePanel();
  if (view === 'github') loadGithubPanel();
}

document.querySelectorAll('.rail-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchRailView(btn.dataset.view));
});

// ---------------- Settings page ----------------
function applyEditorOptionToBoth(opts) {
  if (editor) editor.updateOptions(opts);
  if (splitEditor) splitEditor.updateOptions(opts);
}

function setFontSize(newSize) {
  const clamped = Math.max(9, Math.min(28, newSize));
  uiState.fontSize = clamped;
  applyEditorOptionToBoth({ fontSize: clamped });
  window.nexo.setPrefs({ fontSize: clamped });
  const fontInput = document.getElementById('set-font-size');
  if (fontInput) fontInput.value = clamped;
}
function changeFontSize(delta) { setFontSize(Math.round((uiState.fontSize + delta) * 2) / 2); }
function resetFontSize() { setFontSize(13.5); }

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
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Bracket pair colorization &amp; indent guides</div>
          <div class="settings-row-desc">Color-matches bracket pairs and shows indent guide lines. Off by default — it's one of the pricier Monaco features on large files.</div>
        </div>
        <div class="settings-control"><div class="settings-toggle ${uiState.bracketGuides ? 'on' : ''}" id="set-bracket-guides"></div></div>
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
      <h2>Snippets</h2>
      <div class="settings-row-desc" style="margin-bottom:10px;">Text expansions available in the editor's autocomplete. Type the prefix and accept the suggestion to expand it. Use <code>$1</code>, <code>$2</code>, <code>\${1:default}</code> for tab stops and <code>$0</code> for the final cursor position.</div>
      <div id="snippets-list"></div>
      <button class="tbtn" id="snippets-add-btn">+ Add Snippet</button>
      <div id="snippet-form" class="hidden">
        <div class="snippet-form-row">
          <input type="text" class="settings-text" id="snippet-prefix" placeholder="Prefix (e.g. clg)" spellcheck="false" autocomplete="off" />
          <select class="settings-select" id="snippet-language">
            <option value="all">All languages</option>
            <option value="javascript">JavaScript</option>
            <option value="typescript">TypeScript</option>
            <option value="python">Python</option>
            <option value="html">HTML</option>
            <option value="css">CSS</option>
            <option value="json">JSON</option>
            <option value="markdown">Markdown</option>
          </select>
        </div>
        <input type="text" class="settings-text" id="snippet-description" placeholder="Description (optional)" style="width:100%; margin-top:8px;" />
        <textarea id="snippet-body" placeholder="console.log($1);$0" spellcheck="false"></textarea>
        <div class="snippet-form-actions">
          <button class="tbtn" id="snippet-cancel-btn">Cancel</button>
          <button class="tbtn primary" id="snippet-save-btn">Save Snippet</button>
        </div>
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
      <h2>GitHub</h2>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Personal Access Token</div>
          <div class="settings-row-desc">Powers push/pull without credential prompts, browsing &amp; cloning your repos, creating new repos, and viewing open PRs &amp; issues for the current project. Stored encrypted via your OS keychain — never leaves this device except to talk to api.github.com. Needs the <code>repo</code> scope. <a href="https://github.com/settings/tokens/new" id="gh-token-help">Create one on GitHub →</a></div>
        </div>
        <div class="settings-control" id="gh-token-control"></div>
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

  const bracketGuidesToggle = document.getElementById('set-bracket-guides');
  bracketGuidesToggle.addEventListener('click', () => {
    uiState.bracketGuides = !uiState.bracketGuides;
    bracketGuidesToggle.classList.toggle('on', uiState.bracketGuides);
    applyEditorOptionToBoth({
      bracketPairColorization: { enabled: uiState.bracketGuides },
      guides: { indentation: uiState.bracketGuides, bracketPairs: uiState.bracketGuides },
    });
    window.nexo.setPrefs({ bracketGuides: uiState.bracketGuides });
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

  document.getElementById('set-custom-shell').addEventListener('change', (e) => {
    uiState.customShell = e.target.value.trim();
    window.nexo.setPrefs({ customShell: uiState.customShell });
  });

  document.getElementById('gh-token-help').addEventListener('click', (e) => {
    e.preventDefault();
    window.nexo.openExternal(e.currentTarget.href);
  });
  renderGithubSettingsControl();
  renderSnippetsList();
  wireSnippetForm();
}

async function renderGithubSettingsControl() {
  const box = document.getElementById('gh-token-control');
  if (!box) return;
  box.innerHTML = '<span class="settings-row-desc">Checking…</span>';
  const status = await window.nexo.hasGithubToken();
  if (status.hasToken) {
    const res = await window.nexo.getGithubUser();
    if (res.ok) {
      box.innerHTML = `
        <div class="gh-connected">
          <span class="gh-connected-user">✓ Connected as <strong>${escapeHtml(res.user.login)}</strong></span>
          <button class="tbtn" id="gh-disconnect-btn">Disconnect</button>
        </div>`;
      document.getElementById('gh-disconnect-btn').addEventListener('click', async () => {
        await window.nexo.clearGithubToken();
        renderGithubSettingsControl();
      });
      return;
    }
    // Saved token exists but GitHub no longer accepts it (expired/revoked) — fall through to the connect form.
  }
  box.innerHTML = `
    <input type="password" class="settings-text" id="gh-token-input" placeholder="ghp_…" autocomplete="off" spellcheck="false" />
    <button class="tbtn primary" id="gh-connect-btn">Connect</button>
    <div id="gh-token-error" class="hidden"></div>
  `;
  const errBox = document.getElementById('gh-token-error');
  const connectBtn = document.getElementById('gh-connect-btn');
  const doConnect = async () => {
    const input = document.getElementById('gh-token-input');
    const token = input.value.trim();
    if (!token) return;
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting…';
    errBox.classList.add('hidden');
    const res = await window.nexo.setGithubToken(token);
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
    if (!res.ok) {
      errBox.textContent = res.error;
      errBox.classList.remove('hidden');
      return;
    }
    renderGithubSettingsControl();
  };
  connectBtn.addEventListener('click', doConnect);
  document.getElementById('gh-token-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doConnect(); }
  });
}

// ---------------- Snippets ----------------
let snippetEditingId = null;

function renderSnippetsList() {
  const box = document.getElementById('snippets-list');
  if (!box) return;
  const snippets = uiState.snippets || [];
  if (!snippets.length) {
    box.innerHTML = '<div class="settings-row-desc" style="margin-bottom:10px;">No snippets yet.</div>';
    return;
  }
  box.innerHTML = snippets.map((s) => `
    <div class="snippet-row" data-id="${escapeHtml(s.id)}">
      <div class="snippet-row-main">
        <span class="snippet-prefix">${escapeHtml(s.prefix)}</span>
        <span class="snippet-lang">${escapeHtml(s.language === 'all' ? 'all languages' : s.language)}</span>
        ${s.description ? `<span class="snippet-desc">${escapeHtml(s.description)}</span>` : ''}
      </div>
      <div class="snippet-row-actions">
        <button class="icon-btn snippet-edit-btn" title="Edit">✎</button>
        <button class="icon-btn snippet-delete-btn" title="Delete">🗑</button>
      </div>
    </div>`).join('');
  box.querySelectorAll('.snippet-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => openSnippetForm(btn.closest('.snippet-row').dataset.id));
  });
  box.querySelectorAll('.snippet-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.snippet-row').dataset.id;
      const s = (uiState.snippets || []).find((x) => x.id === id);
      if (s && !confirm(`Delete the "${s.prefix}" snippet?`)) return;
      uiState.snippets = (uiState.snippets || []).filter((x) => x.id !== id);
      await window.nexo.setPrefs({ snippets: uiState.snippets });
      renderSnippetsList();
    });
  });
}

function openSnippetForm(id) {
  const form = document.getElementById('snippet-form');
  form.classList.remove('hidden');
  if (id) {
    const s = (uiState.snippets || []).find((x) => x.id === id);
    if (!s) return;
    snippetEditingId = id;
    document.getElementById('snippet-prefix').value = s.prefix;
    document.getElementById('snippet-language').value = s.language;
    document.getElementById('snippet-description').value = s.description || '';
    document.getElementById('snippet-body').value = s.body;
    document.getElementById('snippet-save-btn').textContent = 'Update Snippet';
  } else {
    snippetEditingId = null;
    document.getElementById('snippet-prefix').value = '';
    document.getElementById('snippet-language').value = 'all';
    document.getElementById('snippet-description').value = '';
    document.getElementById('snippet-body').value = '';
    document.getElementById('snippet-save-btn').textContent = 'Save Snippet';
  }
  document.getElementById('snippet-prefix').focus();
}

function closeSnippetForm() {
  document.getElementById('snippet-form').classList.add('hidden');
  snippetEditingId = null;
}

function wireSnippetForm() {
  document.getElementById('snippets-add-btn').addEventListener('click', () => openSnippetForm(null));
  document.getElementById('snippet-cancel-btn').addEventListener('click', closeSnippetForm);
  document.getElementById('snippet-save-btn').addEventListener('click', async () => {
    const prefix = document.getElementById('snippet-prefix').value.trim();
    const language = document.getElementById('snippet-language').value;
    const description = document.getElementById('snippet-description').value.trim();
    const body = document.getElementById('snippet-body').value;
    if (!prefix) { document.getElementById('snippet-prefix').focus(); return; }
    if (!body.trim()) { document.getElementById('snippet-body').focus(); return; }
    const list = [...(uiState.snippets || [])];
    if (snippetEditingId) {
      const idx = list.findIndex((s) => s.id === snippetEditingId);
      if (idx !== -1) list[idx] = { ...list[idx], prefix, language, description, body };
    } else {
      list.push({ id: `snip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, prefix, language, description, body });
    }
    uiState.snippets = list;
    await window.nexo.setPrefs({ snippets: list });
    closeSnippetForm();
    renderSnippetsList();
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

// ---------------- Outline (symbols) ----------------
// Lightweight regex-based symbol extraction — good enough for jumping around
// a file without pulling in a full language server per language.
function extractSymbols(model, lang) {
  const lines = model.getValue().split('\n');
  const out = [];
  const push = (line, name, kind) => { if (name) out.push({ line, name: name.trim(), kind }); };

  if (lang === 'markdown') {
    lines.forEach((l, i) => {
      const m = l.match(/^(#{1,6})\s+(.+)/);
      if (m) push(i + 1, m[2], `H${m[1].length}`);
    });
    return out;
  }
  if (lang === 'css' || lang === 'scss' || lang === 'less') {
    lines.forEach((l, i) => {
      const m = l.match(/^\s*([.#][A-Za-z0-9_][A-Za-z0-9_.:#\- >]*)\s*\{/);
      if (m) push(i + 1, m[1], 'S');
    });
    return out;
  }
  if (lang === 'python') {
    lines.forEach((l, i) => {
      let m = l.match(/^\s*class\s+([A-Za-z0-9_]+)/);
      if (m) { push(i + 1, m[1], 'C'); return; }
      m = l.match(/^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)/);
      if (m) push(i + 1, m[1], 'F');
    });
    return out;
  }
  // Default: JS/TS/JSX/TSX-ish
  const patterns = [
    [/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_$]+)/, 'C'],
    [/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z0-9_$]+)/, 'F'],
    [/^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/, 'F'],
    [/^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?[A-Za-z0-9_$]*\s*=>/, 'F'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/, 'V'],
  ];
  lines.forEach((l, i) => {
    for (const [re, kind] of patterns) {
      const m = l.match(re);
      if (m) { push(i + 1, m[1], kind); break; }
    }
  });
  return out;
}

function renderOutlinePanel() {
  const box = document.getElementById('outline-list');
  if (!box) return;
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (!tab) { box.innerHTML = '<div id="outline-empty">Open a file to see its outline.</div>'; return; }
  const lang = tab.model.getLanguageId ? tab.model.getLanguageId() : '';
  const symbols = extractSymbols(tab.model, lang);
  if (!symbols.length) { box.innerHTML = '<div id="outline-empty">No symbols found in this file.</div>'; return; }
  box.innerHTML = symbols.map((s) =>
    `<div class="outline-row" data-line="${s.line}"><span class="outline-kind">${escapeHtml(s.kind)}</span><span>${escapeHtml(s.name)}</span></div>`
  ).join('');
  box.querySelectorAll('.outline-row').forEach((row) => {
    row.addEventListener('click', () => {
      const line = parseInt(row.dataset.line, 10);
      if (state.activeTab !== tab.path) activateTab(tab.path);
      if (editor) {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      }
    });
  });
}

function refreshOutlineIfVisible() {
  const panel = document.getElementById('panel-outline');
  if (panel && panel.classList.contains('active')) renderOutlinePanel();
}

let outlineRefreshTimer = null;
function scheduleOutlineRefresh() {
  clearTimeout(outlineRefreshTimer);
  outlineRefreshTimer = setTimeout(refreshOutlineIfVisible, 400);
}

// ---------------- ESLint gutter markers ----------------
// Uses the project's own local eslint install (node_modules/.bin/eslint) —
// never bundled, never auto-installed. Projects without it just get no
// markers, silently, rather than an error toast on every file.
const ESLINT_LANGUAGES = new Set(['javascript', 'typescript']);
const noEslintProjects = new Set();
let eslintLintTimer = null;

function scheduleLint(filePath) {
  clearTimeout(eslintLintTimer);
  eslintLintTimer = setTimeout(() => lintFile(filePath), 700);
}

async function refreshBlameForTab(filePath) {
  if (!state.projectRoot) return;
  const res = await window.nexo.gitBlame(state.projectRoot, filePath);
  const tab = state.openTabs.find((t) => t.path === filePath);
  if (!tab) return; // closed while the request was in flight
  tab.blameLines = res.ok ? res.lines : null; // untracked/new files, or no repo — hover just shows nothing
}

async function lintFile(filePath) {
  if (!state.projectRoot || noEslintProjects.has(state.projectRoot) || !monacoLoaded) return;
  const tab = state.openTabs.find((t) => t.path === filePath);
  if (!tab) return;
  const lang = tab.model.getLanguageId ? tab.model.getLanguageId() : '';
  if (!ESLINT_LANGUAGES.has(lang)) { monaco.editor.setModelMarkers(tab.model, 'eslint', []); return; }
  const res = await window.nexo.lintFile(state.projectRoot, filePath, tab.model.getValue());
  const stillOpen = state.openTabs.find((t) => t.path === filePath);
  if (!stillOpen) return; // tab closed while the lint request was in flight
  if (!res.ok) {
    if (res.reason === 'not-found') noEslintProjects.add(state.projectRoot);
    return;
  }
  const markers = res.messages.map((m) => ({
    startLineNumber: m.line, startColumn: m.column, endLineNumber: m.endLine, endColumn: m.endColumn,
    message: m.ruleId ? `${m.message} (${m.ruleId})` : m.message,
    severity: m.severity === 2 ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
    source: 'eslint',
  }));
  monaco.editor.setModelMarkers(stillOpen.model, 'eslint', markers);
}

// ---------------- npm Scripts panel ----------------
let scriptsState = { scripts: null, error: null };

async function loadScripts() {
  if (!state.projectRoot) { scriptsState = { scripts: null, error: 'Open a folder first.' }; renderScriptsPanel(); return; }
  const sep = state.projectRoot.includes('\\') ? '\\' : '/';
  const pkgPath = state.projectRoot + sep + 'package.json';
  const res = await window.nexo.readFile(pkgPath);
  if (!res.ok) { scriptsState = { scripts: null, error: 'No package.json found in this project.' }; renderScriptsPanel(); return; }
  try {
    const pkg = JSON.parse(res.content);
    scriptsState = { scripts: pkg.scripts || {}, error: null };
  } catch {
    scriptsState = { scripts: null, error: 'Could not parse package.json.' };
  }
  renderScriptsPanel();
}

function orderedScriptNames() {
  const names = Object.keys(scriptsState.scripts || {});
  const order = (uiState.scriptsOrder || []).filter((n) => names.includes(n));
  const rest = names.filter((n) => !order.includes(n));
  return [...order, ...rest];
}

let draggedScriptName = null;

function renderScriptsPanel() {
  const box = document.getElementById('scripts-list');
  if (!box) return;
  if (!scriptsState.scripts) {
    box.innerHTML = `<div id="scripts-empty">${escapeHtml(scriptsState.error || 'Loading…')}</div>`;
    return;
  }
  const names = orderedScriptNames();
  if (!names.length) { box.innerHTML = '<div id="scripts-empty">No scripts defined in package.json.</div>'; return; }
  box.innerHTML = names.map((name) => {
    const running = terminals.some((t) => t.runningScript === name);
    return `
      <div class="script-row" draggable="true" data-script="${escapeHtml(name)}">
        <div class="script-row-main">
          <div class="script-row-name">${escapeHtml(name)}</div>
          <div class="script-row-cmd">${escapeHtml(scriptsState.scripts[name])}</div>
        </div>
        <button class="script-run-btn ${running ? 'running' : ''}" data-script="${escapeHtml(name)}">${running ? '■ Stop' : '▶ Run'}</button>
      </div>`;
  }).join('');
  box.querySelectorAll('.script-run-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.script;
      const runningTerm = terminals.find((t) => t.runningScript === name);
      if (runningTerm) { switchTerminalTab(runningTerm.id); stopTerminalCommand(); }
      else runScript(name);
    });
  });
  box.querySelectorAll('.script-row').forEach((row) => {
    row.addEventListener('dragstart', () => { draggedScriptName = row.dataset.script; });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('script-drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('script-drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('script-drag-over');
      const targetName = row.dataset.script;
      if (!draggedScriptName || draggedScriptName === targetName) return;
      const order = orderedScriptNames();
      const fromIdx = order.indexOf(draggedScriptName);
      const toIdx = order.indexOf(targetName);
      if (fromIdx === -1 || toIdx === -1) return;
      order.splice(fromIdx, 1);
      order.splice(toIdx, 0, draggedScriptName);
      uiState.scriptsOrder = order;
      window.nexo.setPrefs({ scriptsOrder: order });
      draggedScriptName = null;
      renderScriptsPanel();
    });
    row.addEventListener('dragend', () => {
      draggedScriptName = null;
      box.querySelectorAll('.script-drag-over').forEach((r) => r.classList.remove('script-drag-over'));
    });
  });
}

async function runScript(name) {
  if (!state.projectRoot || !scriptsState.scripts || !(name in scriptsState.scripts)) return;
  toggleTerminal(true);
  let t = getActiveTerminal();
  if (t && t.activeRunId) { t = createTerminalSession(); switchTerminalTab(t.id); } // busy tab — run in a fresh one instead of blocking
  if (!t) return;
  resetAnsiState(t);
  const cmd = `npm run ${name}`;
  termAppend(t, `\n$ ${cmd}\n`, 'term-cmd');
  t.history.push(cmd);
  t.historyIdx = t.history.length;
  const res = await window.nexo.runCommand(state.projectRoot, cmd);
  if (!res.id) { termAppend(t, `[error] ${res.error || 'Could not start command.'}\n`, 'term-err'); return; }
  t.activeRunId = res.id;
  t.runningScript = name;
  if (t.id === activeTerminalId) document.getElementById('term-run-btn').textContent = 'Stop';
  renderTerminalTabs();
  renderScriptsPanel();
}

document.getElementById('btn-scripts-refresh').addEventListener('click', loadScripts);

// ---------------- GitHub PRs / Issues panel ----------------
let githubPanelState = { subtab: 'pulls', pulls: null, issues: null, releases: null, pullsError: null, issuesError: null, releasesError: null, error: null, loading: false };

async function loadGithubPanel() {
  const status = await window.nexo.hasGithubToken();
  if (!status.hasToken) {
    githubPanelState = { ...githubPanelState, pulls: null, issues: null, releases: null, error: 'not-connected', loading: false };
    renderGithubPanel();
    return;
  }
  if (!state.projectRoot) {
    githubPanelState = { ...githubPanelState, pulls: null, issues: null, releases: null, error: 'no-project', loading: false };
    renderGithubPanel();
    return;
  }
  githubPanelState.loading = true;
  githubPanelState.error = null;
  renderGithubPanel();
  const [pullsRes, issuesRes, releasesRes] = await Promise.all([
    window.nexo.listGithubPulls(state.projectRoot),
    window.nexo.listGithubIssues(state.projectRoot),
    window.nexo.listGithubReleases(state.projectRoot),
  ]);
  githubPanelState.loading = false;
  if (!pullsRes.ok && !issuesRes.ok && !releasesRes.ok) {
    githubPanelState.error = pullsRes.error || issuesRes.error || releasesRes.error;
  } else {
    githubPanelState.pulls = pullsRes.ok ? pullsRes.pulls : [];
    githubPanelState.issues = issuesRes.ok ? issuesRes.issues : [];
    githubPanelState.releases = releasesRes.ok ? releasesRes.releases : [];
    githubPanelState.pullsError = pullsRes.ok ? null : pullsRes.error;
    githubPanelState.issuesError = issuesRes.ok ? null : issuesRes.error;
    githubPanelState.releasesError = releasesRes.ok ? null : releasesRes.error;
  }
  renderGithubPanel();
}

function renderGithubPanel() {
  document.getElementById('github-tab-pulls').classList.toggle('active', githubPanelState.subtab === 'pulls');
  document.getElementById('github-tab-issues').classList.toggle('active', githubPanelState.subtab === 'issues');
  document.getElementById('github-tab-releases').classList.toggle('active', githubPanelState.subtab === 'releases');
  const body = document.getElementById('github-body');

  if (githubPanelState.error === 'not-connected') {
    body.innerHTML = '<div class="git-empty">Connect a GitHub token in Settings to see PRs, issues &amp; releases.</div>';
    return;
  }
  if (githubPanelState.error === 'no-project') {
    body.innerHTML = '<div class="git-empty">Open a project first.</div>';
    return;
  }
  if (githubPanelState.loading) {
    body.innerHTML = '<div class="git-empty">Loading…</div>';
    return;
  }
  if (githubPanelState.error) {
    body.innerHTML = `<div class="git-empty">${escapeHtml(githubPanelState.error)}</div>`;
    return;
  }

  if (githubPanelState.subtab === 'releases') {
    renderReleasesSubtab(body);
    return;
  }

  const items = githubPanelState.subtab === 'pulls' ? githubPanelState.pulls : githubPanelState.issues;
  const itemsError = githubPanelState.subtab === 'pulls' ? githubPanelState.pullsError : githubPanelState.issuesError;
  if (itemsError) { body.innerHTML = `<div class="git-empty">${escapeHtml(itemsError)}</div>`; return; }
  if (!items || !items.length) {
    body.innerHTML = `<div class="git-empty">No open ${githubPanelState.subtab === 'pulls' ? 'pull requests' : 'issues'}.</div>`;
    return;
  }
  body.innerHTML = items.map((it) => `
    <div class="gh-item-row" data-url="${escapeHtml(it.url)}">
      <div class="gh-item-title">${it.draft ? '<span class="gh-draft-badge">Draft</span>' : ''}${escapeHtml(it.title)}</div>
      <div class="gh-item-meta">#${it.number} · ${escapeHtml(it.author)}${githubPanelState.subtab === 'pulls' ? ` · ${escapeHtml(it.branch)}` : ''}</div>
      ${it.labels && it.labels.length ? `<div class="gh-item-labels">${it.labels.map((l) => `<span class="gh-label">${escapeHtml(l)}</span>`).join('')}</div>` : ''}
    </div>
  `).join('');
  body.querySelectorAll('.gh-item-row').forEach((row) => {
    row.addEventListener('click', () => window.nexo.openExternal(row.dataset.url));
  });
}

function renderReleasesSubtab(body) {
  if (githubPanelState.releasesError) {
    body.innerHTML = `<div class="git-empty">${escapeHtml(githubPanelState.releasesError)}</div>`;
    return;
  }
  const releases = githubPanelState.releases || [];
  const listHtml = releases.length
    ? releases.map((r) => `
      <div class="gh-item-row" data-url="${escapeHtml(r.url)}">
        <div class="gh-item-title">
          ${r.draft ? '<span class="gh-draft-badge">Draft</span>' : ''}${r.prerelease ? '<span class="gh-draft-badge">Pre-release</span>' : ''}${escapeHtml(r.name)}
        </div>
        <div class="gh-item-meta">${escapeHtml(r.tagName)}${r.publishedAt ? ` · ${new Date(r.publishedAt).toLocaleDateString()}` : ''}</div>
      </div>`).join('')
    : '<div class="git-empty">No releases yet.</div>';
  body.innerHTML = `<div class="gh-releases-actions"><button class="tbtn" id="gh-new-release-btn">+ New Release</button></div>${listHtml}`;
  body.querySelectorAll('.gh-item-row').forEach((row) => {
    row.addEventListener('click', () => window.nexo.openExternal(row.dataset.url));
  });
  document.getElementById('gh-new-release-btn').addEventListener('click', openCreateReleaseForm);
}

function openCreateReleaseForm() {
  showModal({
    title: 'Create GitHub Release',
    fields: [
      { id: 'tagName', placeholder: 'v1.0.0' },
      { id: 'name', placeholder: 'Release title (optional — defaults to tag)', required: false },
      { id: 'body', placeholder: 'Release notes (optional)', required: false },
    ],
    confirmLabel: 'Next',
    onConfirm: ({ tagName, name, body }) => {
      if (!tagName.trim()) return 'Tag name is required.';
      setTimeout(() => continueCreateReleaseFlow(tagName.trim(), name.trim(), body), 50);
      return null;
    },
  });
}

async function continueCreateReleaseFlow(tagName, name, body) {
  const draft = confirm('Save as a draft (not published yet)?\n\nOK = draft, Cancel = publish immediately');
  let prerelease = false;
  if (!draft) prerelease = confirm('Mark this as a pre-release?\n\nOK = pre-release, Cancel = full release');
  showUpdateToast('Creating release…', []);
  const res = await window.nexo.createGithubRelease(state.projectRoot, {
    tagName, name, body, draft, prerelease, targetCommitish: gitState.branch || undefined,
  });
  hideUpdateToast();
  if (!res.ok) { alert(`Could not create release:\n${res.error}`); return; }
  if (document.getElementById('panel-github').classList.contains('active')) loadGithubPanel();
}

document.getElementById('github-tab-pulls').addEventListener('click', () => { githubPanelState.subtab = 'pulls'; renderGithubPanel(); });
document.getElementById('github-tab-issues').addEventListener('click', () => { githubPanelState.subtab = 'issues'; renderGithubPanel(); });
document.getElementById('github-tab-releases').addEventListener('click', () => { githubPanelState.subtab = 'releases'; renderGithubPanel(); });
document.getElementById('btn-github-refresh').addEventListener('click', loadGithubPanel);
document.getElementById('btn-github-new-repo').addEventListener('click', handleCreateGithubRepo);

// ---------------- Command Palette / Quick Open ----------------
const paletteState = { mode: 'files', items: [], active: 0, filesCache: null };

const PALETTE_COMMANDS = [
  { label: 'Open Folder…', run: handleOpenFolder },
  { label: 'New File', run: handleNewFile },
  { label: 'Save', run: saveActiveTab },
  { label: 'Save As…', run: saveActiveTabAs },
  { label: 'Find in Files', run: () => switchRailView('search') },
  { label: 'Source Control', run: () => switchRailView('git') },
  { label: 'npm Scripts', run: () => switchRailView('scripts') },
  { label: 'Outline', run: () => switchRailView('outline') },
  { label: 'Settings', run: () => switchRailView('settings') },
  { label: 'GitHub', run: () => switchRailView('github') },
  { label: 'Browse GitHub Repos…', run: openGithubRepoPicker },
  { label: 'Create GitHub Repo…', run: handleCreateGithubRepo },
  { label: 'Create GitHub Release…', run: () => { switchRailView('github'); githubPanelState.subtab = 'releases'; renderGithubPanel(); openCreateReleaseForm(); } },
  { label: 'Toggle Terminal', run: () => toggleTerminal() },
  { label: 'Toggle Split Editor', run: () => toggleSplit() },
  { label: 'Toggle Zen Mode', run: () => toggleZenMode() },
  { label: 'Toggle Sidebar', run: () => { const sb = document.getElementById('sidebar'); sb.style.display = sb.style.display === 'none' ? 'flex' : 'none'; } },
  { label: 'Check for Updates…', run: () => window.nexo.checkForUpdates(true) },
];

async function openPalette(mode) {
  const overlay = document.getElementById('palette-overlay');
  const input = document.getElementById('palette-input');
  paletteState.mode = mode;
  overlay.classList.remove('hidden');
  input.value = mode === 'commands' ? '>' : '';
  input.placeholder = mode === 'github-repos' ? 'Search your GitHub repos…' : 'Search files… (type > for commands)';
  if (mode === 'files' && state.projectRoot) {
    if (!paletteState.filesCache) {
      const res = await window.nexo.listFiles(state.projectRoot);
      paletteState.filesCache = res.files || [];
    }
  }
  if (mode === 'github-repos') {
    const status = await window.nexo.hasGithubToken();
    if (!status.hasToken) {
      closePalette();
      alert('Connect a GitHub token in Settings first.');
      return;
    }
    document.getElementById('palette-empty').textContent = 'Loading your repos…';
    document.getElementById('palette-empty').classList.remove('hidden');
    document.getElementById('palette-list').innerHTML = '';
    const res = await window.nexo.listGithubRepos();
    if (!res.ok) {
      closePalette();
      alert(`Could not load GitHub repos:\n${res.error}`);
      return;
    }
    paletteState.githubRepos = res.repos;
  }
  renderPaletteResults();
  input.focus();
  input.select();
}

function closePalette() {
  document.getElementById('palette-overlay').classList.add('hidden');
}

function paletteFuzzyMatch(query, text) {
  if (!query) return true;
  let qi = 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function renderPaletteResults() {
  const raw = document.getElementById('palette-input').value;
  const isCommand = raw.startsWith('>');
  const query = isCommand ? raw.slice(1).trim() : raw.trim();

  let items = [];
  if (paletteState.mode === 'github-repos') {
    const repos = paletteState.githubRepos || [];
    items = repos
      .filter((r) => paletteFuzzyMatch(raw.trim(), r.fullName))
      .slice(0, 200)
      .map((r) => ({
        label: r.fullName,
        meta: r.private ? 'private' : 'public',
        icon: '📦',
        run: () => continueCloneFlow(r.cloneUrl),
      }));
  } else if (isCommand) {
    items = PALETTE_COMMANDS
      .filter((c) => paletteFuzzyMatch(query, c.label))
      .map((c) => ({ label: c.label, icon: '⚡', run: c.run }));
  } else if (state.projectRoot) {
    const files = paletteState.filesCache || [];
    items = files
      .filter((f) => paletteFuzzyMatch(query, f))
      .slice(0, 200)
      .map((f) => ({ label: f.split(/[\\/]/).pop(), meta: f, icon: fileIcon(f, false), run: () => openFile(f) }));
  }

  paletteState.items = items;
  paletteState.active = 0;
  const list = document.getElementById('palette-list');
  const empty = document.getElementById('palette-empty');
  if (!items.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = state.projectRoot || isCommand ? 'No matches.' : 'Open a folder to search its files.';
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = items.map((it, i) => `
    <div class="palette-item ${i === 0 ? 'active' : ''}" data-idx="${i}">
      <span class="palette-icon">${it.icon || ''}</span>
      <span class="palette-label">${escapeHtml(it.label)}</span>
      ${it.meta ? `<span class="palette-meta">${escapeHtml(it.meta)}</span>` : ''}
    </div>`).join('');
  list.querySelectorAll('.palette-item').forEach((el) => {
    el.addEventListener('click', () => runPaletteItem(parseInt(el.dataset.idx, 10)));
  });
}

function runPaletteItem(idx) {
  const item = paletteState.items[idx];
  if (!item) return;
  closePalette();
  item.run();
}

function setPaletteActive(idx) {
  const list = document.getElementById('palette-list');
  const rows = list.querySelectorAll('.palette-item');
  if (!rows.length) return;
  paletteState.active = Math.max(0, Math.min(idx, rows.length - 1));
  rows.forEach((r, i) => r.classList.toggle('active', i === paletteState.active));
  rows[paletteState.active].scrollIntoView({ block: 'nearest' });
}

document.getElementById('palette-input').addEventListener('input', renderPaletteResults);
document.getElementById('palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteActive(paletteState.active + 1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteActive(paletteState.active - 1); return; }
  if (e.key === 'Enter') { e.preventDefault(); runPaletteItem(paletteState.active); }
});
document.getElementById('palette-overlay').addEventListener('mousedown', (e) => {
  if (e.target.id === 'palette-overlay') closePalette();
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
