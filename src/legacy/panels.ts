
// ---------------- Outline (symbols) ----------------
// Lightweight regex-based symbol extraction — good enough for jumping around
// a file without pulling in a full language server per language.
function extractSymbols(model: any, lang: any) {
  const lines = model.getValue().split('\n');
  const out: any = [];
  const push = (line: any, name: any, kind: any) => { if (name) out.push({ line, name: name.trim(), kind }); };

  if (lang === 'markdown') {
    lines.forEach((l: any, i: any) => {
      const m = l.match(/^(#{1,6})\s+(.+)/);
      if (m) push(i + 1, m[2], `H${m[1].length}`);
    });
    return out;
  }
  if (lang === 'css' || lang === 'scss' || lang === 'less') {
    lines.forEach((l: any, i: any) => {
      const m = l.match(/^\s*([.#][A-Za-z0-9_][A-Za-z0-9_.:#\- >]*)\s*\{/);
      if (m) push(i + 1, m[1], 'S');
    });
    return out;
  }
  if (lang === 'python') {
    lines.forEach((l: any, i: any) => {
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
  lines.forEach((l: any, i: any) => {
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
  box.innerHTML = symbols.map((s: any) =>
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

let outlineRefreshTimer: any = null;
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
let eslintLintTimer: any = null;

function scheduleLint(filePath: any) {
  clearTimeout(eslintLintTimer);
  eslintLintTimer = setTimeout(() => lintFile(filePath), 700);
}

async function refreshBlameForTab(filePath: any) {
  if (!state.projectRoot) return;
  const res = await window.nexo.gitBlame(state.projectRoot, filePath);
  const tab = state.openTabs.find((t) => t.path === filePath);
  if (!tab) return; // closed while the request was in flight
  tab.blameLines = res.ok ? res.lines : null; // untracked/new files, or no repo — hover just shows nothing
}

async function lintFile(filePath: any) {
  if (/\.pyw?$/i.test(filePath)) return lintPythonFile(filePath);
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
  const markers = res.messages.map((m: any) => ({
    startLineNumber: m.line, startColumn: m.column, endLineNumber: m.endLine, endColumn: m.endColumn,
    message: m.ruleId ? `${m.message} (${m.ruleId})` : m.message,
    severity: m.severity === 2 ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
    source: 'eslint',
  }));
  monaco.editor.setModelMarkers(stillOpen.model, 'eslint', markers);
}

// ---------------- npm Scripts panel ----------------
let scriptsState: any = { scripts: null, error: null };

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
  const order = (uiState.scriptsOrder || []).filter((n: any) => names.includes(n));
  const rest = names.filter((n) => !order.includes(n));
  return [...order, ...rest];
}

let draggedScriptName: any = null;

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

async function runCommandInTerminal(cmd: any, runningLabel?: any) {
  if (!state.projectRoot) return;
  toggleTerminal(true);
  let t = getActiveTerminal();
  if (t && t.activeRunId) { t = createTerminalSession(); switchTerminalTab(t.id); } // busy tab — run in a fresh one instead of blocking
  if (!t) return;
  resetAnsiState(t);
  termAppend(t, `\n$ ${cmd}\n`, 'term-cmd');
  t.history.push(cmd);
  t.historyIdx = t.history.length;
  const res = await window.nexo.runCommand(state.projectRoot, cmd);
  if (!res.id) { termAppend(t, `[error] ${res.error || 'Could not start command.'}\n`, 'term-err'); return; }
  t.activeRunId = res.id;
  if (runningLabel) t.runningScript = runningLabel;
  if (t.id === activeTerminalId) document.getElementById('term-run-btn')!.textContent = 'Stop';
  renderTerminalTabs();
  renderScriptsPanel();
}

async function runScript(name: any) {
  if (!state.projectRoot || !scriptsState.scripts || !(name in scriptsState.scripts)) return;
  if (!isSafeToken(name)) { flashToast('Script name contains unsafe characters.'); return; }
  await runCommandInTerminal(`npm run -- ${name}`, name);
}

let scriptsSubtab = 'scripts';

function switchScriptsSubtab(tab: any) {
  scriptsSubtab = tab;
  document.getElementById('scripts-tab-scripts')!.classList.toggle('active', tab === 'scripts');
  document.getElementById('scripts-tab-outdated')!.classList.toggle('active', tab === 'outdated');
  document.getElementById('scripts-list')!.classList.toggle('hidden', tab !== 'scripts');
  document.getElementById('outdated-list')!.classList.toggle('hidden', tab !== 'outdated');
  if (tab === 'outdated' && outdatedState.packages === null) loadOutdated();
}

document.getElementById('scripts-tab-scripts')!.addEventListener('click', () => switchScriptsSubtab('scripts'));
document.getElementById('scripts-tab-outdated')!.addEventListener('click', () => switchScriptsSubtab('outdated'));

document.getElementById('btn-scripts-refresh')!.addEventListener('click', () => {
  if (scriptsSubtab === 'outdated') loadOutdated(true);
  else loadScripts();
});

// ---------------- Outdated dependencies ----------------
let outdatedState: any = { packages: null, error: null, loading: false };

async function loadOutdated(forceRefresh = false) {
  if (!state.projectRoot) { outdatedState = { packages: null, error: 'Open a folder first.', loading: false }; renderOutdatedList(); return; }
  outdatedState = { packages: null, error: null, loading: true };
  renderOutdatedList();
  const res = await window.nexo.checkOutdated(state.projectRoot, forceRefresh);
  if (res.reason === 'no-package-json') {
    outdatedState = { packages: null, error: 'No package.json found in this project.', loading: false };
  } else if (!res.ok) {
    outdatedState = { packages: null, error: res.error || 'Could not check for outdated packages.', loading: false };
  } else {
    outdatedState = { packages: res.packages, error: null, loading: false };
  }
  renderOutdatedList();
}

function renderOutdatedList() {
  const box = document.getElementById('outdated-list');
  if (!box) return;
  if (outdatedState.loading) { box.innerHTML = '<div id="scripts-empty">Checking for outdated packages…</div>'; return; }
  if (outdatedState.error) { box.innerHTML = `<div id="scripts-empty">${escapeHtml(outdatedState.error)}</div>`; return; }
  const packages = outdatedState.packages || [];
  if (!packages.length) { box.innerHTML = '<div id="scripts-empty">Everything is up to date.</div>'; return; }
  box.innerHTML = `
    <div class="outdated-actions"><button class="tbtn" id="btn-update-all">Update All (npm update)</button></div>
    ${packages.map((p: any) => `
      <div class="outdated-row">
        <div class="outdated-row-main">
          <div class="outdated-row-name">${escapeHtml(p.name)}</div>
          <div class="outdated-row-versions">${escapeHtml(p.current)} → <span class="outdated-wanted">${escapeHtml(p.wanted)}</span> (latest: <span class="outdated-latest">${escapeHtml(p.latest)}</span>)</div>
        </div>
        <button class="script-run-btn" data-pkg="${escapeHtml(p.name)}">Update</button>
      </div>`).join('')}
  `;
  document.getElementById('btn-update-all')!.addEventListener('click', () => runCommandInTerminal('npm update'));
  box.querySelectorAll('.outdated-row .script-run-btn').forEach((btn) => {
    btn.addEventListener('click', () => { if (isSafeToken(btn.dataset.pkg)) runCommandInTerminal(`npm install ${btn.dataset.pkg}@latest`); });
  });
}
