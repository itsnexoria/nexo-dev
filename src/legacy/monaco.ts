
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
  getWorkerUrl(_moduleId: any, _label: any) {
    const bootstrap = `
      self.MonacoEnvironment = { baseUrl: '${VS_BASE}../' }; // parent of vs/: the AMD loader adds the vs/ segment itself
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
function monacoThemeId(themeId: any) {
  return (THEMES.find((t) => t.id === themeId) || THEMES[0]).monaco;
}
const CUSTOM_THEME_META = { id: 'custom', label: 'Custom', monaco: 'nexo-custom', icon: '🎨' };

// ---------------- Custom theme color math ----------------
// Takes just three user-picked colors (background, text, accent) and derives
// a full palette matching every variable the four built-in themes define —
// so picking a custom theme feels as simple as it should, without asking
// anyone to hand-tune 20 individual colors.
function hexToRgb(hex: any) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c: any) => c + c).join('');
  const num = parseInt(h, 16) || 0;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function rgbToHex({ r, g, b }: any) {
  const clamp = (v: any) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('');
}
function mixHex(hexA: any, hexB: any, weightB: any) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return rgbToHex({
    r: a.r + (b.r - a.r) * weightB,
    g: a.g + (b.g - a.g) * weightB,
    b: a.b + (b.b - a.b) * weightB,
  });
}
function relativeLuminance(hex: any) {
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

function buildCustomThemeVars({ bg, text, accent }: any) {
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

function applyCustomThemeVars(vars: any) {
  for (const key of CUSTOM_VAR_KEYS) document.body.style.setProperty(`--${key}`, vars[key]);
}
function clearCustomThemeVars() {
  for (const key of CUSTOM_VAR_KEYS) document.body.style.removeProperty(`--${key}`);
}
function applyCustomMonacoTheme(vars: any) {
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
function addSelectAllAction(ed: any) {
  ed.addAction({
    id: 'nexo-select-all',
    label: 'Select All',
    contextMenuGroupId: '9_cutcopypaste',
    contextMenuOrder: 4,
    run: (instance: any) => {
      const model = instance.getModel();
      if (model) instance.setSelection(model.getFullModelRange());
    },
  });
}

function initMonaco(cb: any) {
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
      glyphMargin: true,
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

    editor.onDidChangeCursorPosition((e: any) => {
      document.getElementById('status-pos')!.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
      saveSessionDebounced();
    });
    addSelectAllAction(editor);
    initDebugEditorHooks();
    registerPythonIntel();
    editor.addAction({ id: 'nexo.py.gotoDefinition', label: 'Python: Go to Definition', keybindings: [monaco.KeyCode.F12], run: () => pyGoToDefinition() });
    // Keep our own font-size setting (and Settings page, and prefs.json) in
    // sync no matter how the size changed — our own zoom shortcuts, or
    // Monaco's own Ctrl+scroll-wheel zoom, both land here.
    editor.onDidChangeConfiguration((e: any) => {
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
    registerConflictCodeLensProvider();
    if (uiState.vimMode) enableVimMode();
    cb();
  });
}

// ---------------- Vim keybindings (loaded on demand) ----------------
// monaco-vim's UMD wrapper checks `define.amd` to decide whether to register
// itself as an AMD module or set window.MonacoVim. Monaco's own AMD loader
// stays resident on the page indefinitely after it loads, so a plain
// <script> tag added at any later point would get silently routed into the
// AMD branch instead — which won't resolve correctly against our local
// Monaco build. Working around it the same way several other tools do:
// temporarily undefine `define` for the duration of the script load so the
// UMD wrapper falls into its plain-global branch instead, then restore it.
let monacoVimLoaded = false;
let vimModeDisposable: any = null;

function loadMonacoVim(cb: any) {
  if (monacoVimLoaded && window.MonacoVim) { cb(); return; }
  const savedDefine = window.define;
  window.define = undefined;
  const script = document.createElement('script');
  script.src = '../node_modules/monaco-vim/dist/monaco-vim.umd.js';
  script.onload = () => {
    window.define = savedDefine;
    monacoVimLoaded = true;
    cb();
  };
  script.onerror = () => {
    window.define = savedDefine;
    alert('Could not load Vim mode — the monaco-vim package may be missing from this install.');
  };
  document.head.appendChild(script);
}

function enableVimMode() {
  if (!editor) return;
  loadMonacoVim(() => {
    if (vimModeDisposable) return; // already on
    const statusBar = document.getElementById('vim-status-bar');
    statusBar!.classList.remove('hidden');
    vimModeDisposable = window.MonacoVim.initVimMode(editor, statusBar);
  });
}

function disableVimMode() {
  if (vimModeDisposable) {
    vimModeDisposable.dispose();
    vimModeDisposable = null;
  }
  document.getElementById('vim-status-bar')!.classList.add('hidden');
}

// User-defined snippets (Settings → Snippets). Registered once per language
// id we support — Monaco has no true wildcard selector, so 'all'-scoped
// snippets are just filtered into every one of these providers instead.
function registerSnippetProvider() {
  const languageIds = [...new Set(Object.values(LANG_MAP))];
  const provider: any = {
    triggerCharacters: [],
    provideCompletionItems(model: any, position: any) {
      const lang = model.getLanguageId();
      const list = (uiState.snippets || []).filter((s: any) => s.language === 'all' || s.language === lang);
      if (!list.length) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      return {
        suggestions: list.map((s: any) => ({
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
    provideHover(model: any, position: any) {
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
function applyPerfOptionsForFile(byteLength: any) {
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
