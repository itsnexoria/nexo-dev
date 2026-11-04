
// ---------------- Python panel ----------------
let pyState: any = { subtab: 'env', info: null, selected: null, packages: null, outdated: null, tests: null, testsError: null, error: null, loading: false };
const PY_TABS = ['env', 'packages', 'outdated', 'tests'];

const IS_WIN = /win/i.test(navigator.platform || '');
function pyQuote(p: any) {
  const v = String(p);
  // POSIX: single quotes disable $(...), backticks and $VAR expansion.
  if (!IS_WIN) return `'${v.replace(/'/g, `'\\''`)}'`;
  return `"${v.replace(/"/g, '\\"')}"`;
}
// Package/script/venv names come from files in the (possibly untrusted) project.
const SAFE_TOKEN_RE = /^[@A-Za-z0-9._\/:~^+-]+$/;
function isSafeToken(v: any) { return typeof v === 'string' && SAFE_TOKEN_RE.test(v) && !v.startsWith('-'); }
function pySafeArg(v: any) { return v && !/[;&|`$<>\n]/.test(v); }

function pyActiveBin() {
  const info = pyState.info;
  if (!info) return null;
  const v = (info.venvs || []).find((x: any) => x.dir === pyState.selected) || (info.venvs || [])[0];
  if (v) return { bin: v.bin, label: v.dir, venv: true, dir: v.dir };
  if (info.system) return { bin: info.system.bin, label: 'system', venv: false };
  return null;
}

// Package-manager aware commands (pip / uv / poetry / pipenv)
function pyCmd(action: any, arg?: any) {
  const a = pyActiveBin();
  const pip = a ? `${pyQuote(a.bin)} -m pip` : 'python -m pip';
  const mgr = (pyState.info && pyState.info.manager) || 'pip';
  const q = arg ? pyQuote(arg) : '';
  const table: any = {
    pip:    { install: `${pip} install ${q}`, remove: `${pip} uninstall -y ${q}`, upgrade: `${pip} install --upgrade ${q}`, sync: 'requirements' },
    uv:     { install: `uv add ${q}`, remove: `uv remove ${q}`, upgrade: `uv lock --upgrade-package ${q} && uv sync`, sync: 'uv sync' },
    poetry: { install: `poetry add ${q}`, remove: `poetry remove ${q}`, upgrade: `poetry update ${q}`, sync: 'poetry install' },
    pipenv: { install: `pipenv install ${q}`, remove: `pipenv uninstall ${q}`, upgrade: `pipenv update ${q}`, sync: 'pipenv install --dev' },
  };
  return table[mgr][action];
}

function pyActivateCmd(dir: any) {
  return pyState.info && pyState.info.platform === 'win32' ? `${dir}\\Scripts\\activate` : `source ${dir}/bin/activate`;
}

// ---- status bar interpreter indicator ----
async function refreshPyStatus() {
  const el = document.getElementById('status-py');
  if (!el) return;
  if (!state.projectRoot) { el.classList.add('hidden'); return; }
  const r = await window.nexo.pyResolve(state.projectRoot);
  if (!r) { el.textContent = '🐍 No Python'; el.classList.remove('hidden'); return; }
  const ver = (r.version || '').replace(/^Python\s*/i, '');
  el.textContent = `🐍 ${r.venv || 'system'}${ver ? ' (' + ver + ')' : ''}`;
  el.title = r.bin + ' — click to manage';
  el.classList.remove('hidden');
}
document.getElementById('status-py')!.addEventListener('click', () => switchRailView('python'));

async function loadPython(force = false) {
  if (!state.projectRoot) { pyState.info = null; pyState.error = 'Open a folder first.'; renderPython(); return; }
  pyState.error = null; pyState.loading = true; renderPython();
  const info = await window.nexo.pyInfo(state.projectRoot);
  pyState.loading = false;
  if (!info.ok) { pyState.error = info.error; renderPython(); return; }
  pyState.info = info;
  if (!info.venvs.find((v: any) => v.dir === pyState.selected)) pyState.selected = info.selected || (info.venvs[0] && info.venvs[0].dir) || null;
  await window.nexo.pySelect(state.projectRoot, pyState.selected);
  pyState.packages = null; pyState.outdated = null; pyState.tests = null;
  renderPython();
  refreshPyStatus();
  if (pyState.subtab === 'packages') loadPyPackages();
  if (pyState.subtab === 'outdated') loadPyOutdated(force);
  if (pyState.subtab === 'tests') loadPyTests();
}

async function loadPyPackages() {
  const a = pyActiveBin();
  if (!a) return;
  pyState.packages = null; pyState.error = null; renderPython();
  const res = await window.nexo.pyList(state.projectRoot, a.bin);
  if (res.ok) pyState.packages = res.packages; else pyState.error = res.error;
  renderPython();
}

async function loadPyOutdated(force: any) {
  const a = pyActiveBin();
  if (!a) return;
  pyState.outdated = null; pyState.error = null; pyState.loading = true; renderPython();
  const res = await window.nexo.pyOutdated(state.projectRoot, a.bin, force);
  pyState.loading = false;
  if (res.ok) pyState.outdated = res.packages; else pyState.error = res.error;
  renderPython();
}

async function loadPyTests() {
  pyState.tests = null; pyState.testsError = null; pyState.loading = true; renderPython();
  const res = await window.nexo.pyTests(state.projectRoot);
  pyState.loading = false;
  if (res.ok) pyState.tests = res.tests;
  else pyState.testsError = res.reason === 'no-pytest' ? 'no-pytest' : (res.error || 'Could not collect tests.');
  renderPython();
}

function switchPySubtab(tab: any) {
  pyState.subtab = tab;
  PY_TABS.forEach((t) => document.getElementById(`py-tab-${t}`)!.classList.toggle('active', t === tab));
  pyState.error = null;
  renderPython();
  if (tab === 'packages' && pyState.packages === null) loadPyPackages();
  if (tab === 'outdated' && pyState.outdated === null) loadPyOutdated(false);
  if (tab === 'tests' && pyState.tests === null && !pyState.testsError) loadPyTests();
}
PY_TABS.forEach((t) => document.getElementById(`py-tab-${t}`)!.addEventListener('click', () => switchPySubtab(t)));
document.getElementById('btn-python-refresh')!.addEventListener('click', () => loadPython(true));

function pyAfterChange(ms: any) {
  setTimeout(() => { pyState.packages = null; pyState.outdated = null; if (pyState.subtab === 'packages') loadPyPackages(); }, ms);
}

// ---- run / debug the current file ----
async function runPythonFile(debug = false) {
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (!tab || !/\.pyw?$/i.test(tab.path)) { flashToast('Open a .py file first'); return; }
  if (!state.projectRoot) return;
  if (tab.modified && typeof saveActiveTab === 'function') await saveActiveTab();
  const r = await window.nexo.pyResolve(state.projectRoot);
  if (!r) { flashToast('Python not found'); return; }
  await runCommandInTerminal(`${pyQuote(r.bin)} ${debug ? '-X dev -u ' : ''}${pyQuote(tab.path)}`, 'py:' + tab.path);
}

// ---- pytest ----
function runPytest(target: any) {
  const r = pyActiveBin();
  const py = r ? pyQuote(r.bin) : 'python';
  runCommandInTerminal(`${py} -m pytest ${target ? pyQuote(target) : ''} -v`, 'pytest');
}

function renderPython() {
  const box = document.getElementById('python-body');
  if (!box) return;
  const msg = (t: any) => { box.innerHTML = `<div id="scripts-empty">${escapeHtml(t)}</div>`; };
  if (!state.projectRoot) return msg('Open a folder first.');
  if (!pyState.info) return msg(pyState.loading ? 'Detecting Python…' : (pyState.error || 'Loading…'));
  const info = pyState.info;
  const a = pyActiveBin();
  const mgr = info.manager || 'pip';

  if (pyState.subtab === 'env') {
    const sysLine = info.system ? `${escapeHtml(info.system.version)} <span class="script-row-cmd">(${escapeHtml(info.system.bin)})</span>` : 'Python not found on PATH.';
    const venvs = info.venvs.map((v: any) => `
      <div class="script-row py-row ${v.dir === (a && a.dir) ? 'selected' : ''}" data-venv="${escapeHtml(v.dir)}" style="cursor:pointer">
        <div class="script-row-main">
          <div class="script-row-name">${escapeHtml(v.dir)}${v.dir === (a && a.dir) ? ' ✓ active' : ''}</div>
          <div class="script-row-cmd">${escapeHtml(v.version || v.bin)}</div>
        </div>
        <button class="script-run-btn" data-activate="${escapeHtml(v.dir)}" title="Activate in the terminal">Activate</button>
      </div>`).join('') || '<div id="scripts-empty">No virtual environment found (.venv, venv, env).</div>';
    const files = info.files.length ? info.files.map(escapeHtml).join(', ') : 'none';
    const syncBtn = mgr === 'pip'
      ? (info.files.includes('requirements.txt') ? '<button class="tbtn" id="py-sync">pip install -r requirements.txt</button>' : '')
      : `<button class="tbtn" id="py-sync">${escapeHtml(pyCmd('sync'))}</button>`;
    box.innerHTML = `
      <div class="py-section"><div class="py-section-title">Interpreter</div>
        <div class="script-row"><div class="script-row-main"><div class="script-row-name">${sysLine}</div></div></div>
        <div class="script-row-cmd" style="padding:2px 4px">Terminals use the active venv automatically.</div></div>
      <div class="py-section"><div class="py-section-title">Virtual environments</div>${venvs}
        <div class="py-input-row"><input id="py-venv-name" value=".venv" spellcheck="false" /><button class="tbtn" id="py-create-venv" ${info.system ? '' : 'disabled'}>Create venv</button></div>
      </div>
      <div class="py-section"><div class="py-section-title">Project · ${escapeHtml(mgr)}</div>
        <div class="script-row-cmd" style="padding:0 4px 6px">${files}</div>
        <div class="py-actions">
          ${syncBtn}
          ${info.files.includes('pyproject.toml') || info.files.includes('setup.py') ? '<button class="tbtn" id="py-install-editable">pip install -e .</button>' : ''}
        </div>
      </div>
      <div class="py-section"><div class="py-section-title">Dev tools</div>
        <div class="py-actions">
          <button class="tbtn" id="py-install-ruff">Install ruff (linting)</button>
          <button class="tbtn" id="py-install-pytest">Install pytest</button>
          <button class="tbtn" id="py-install-jedi">Install jedi (IntelliSense)</button>
          <button class="tbtn" id="py-install-debugpy">Install debugpy (debugging)</button>
          <button class="tbtn" id="py-install-black">Install black (formatting)</button>
          <button class="tbtn" id="py-install-nb">Install matplotlib (notebook plots)</button>
        </div>
      </div>`;
    box.querySelectorAll('[data-venv]').forEach((row) => row.addEventListener('click', async (e) => {
      if (e.target!.closest('[data-activate]')) return;
      pyState.selected = row.dataset.venv; pyState.packages = null; pyState.outdated = null; pyState.tests = null;
      await window.nexo.pySelect(state.projectRoot, pyState.selected);
      await window.nexo.pyLintReset(state.projectRoot);
      pyJediWarned = false;
      renderPython(); refreshPyStatus();
    }));
    box.querySelectorAll('[data-activate]').forEach((b) => b.addEventListener('click', () => runCommandInTerminal(pyActivateCmd(b.dataset.activate))));
    const create = document.getElementById('py-create-venv');
    if (create) create.addEventListener('click', async () => {
      const name = (document.getElementById('py-venv-name')!.value || '.venv').trim();
      if (!/^[\w.\-]+$/.test(name)) return;
      await runCommandInTerminal(mgr === 'uv' ? `uv venv ${name}` : `${info.system.bin} -m venv ${name}`);
      pyState.selected = name;
      setTimeout(() => loadPython(), 5000);
    });
    const sync = document.getElementById('py-sync');
    if (sync) sync.addEventListener('click', () => {
      runCommandInTerminal(mgr === 'pip' ? `${pyQuote(a!.bin)} -m pip install -r requirements.txt` : pyCmd('sync'));
      pyAfterChange(8000);
    });
    const ed = document.getElementById('py-install-editable');
    if (ed && a) ed.addEventListener('click', () => { runCommandInTerminal(`${pyQuote(a.bin)} -m pip install -e .`); pyAfterChange(8000); });
    const tool = (id: any, pkg: any) => document.getElementById(id)!.addEventListener('click', () => {
      if (!a) return;
      runCommandInTerminal(`${pyQuote(a.bin)} -m pip install ${pkg}`);
      setTimeout(() => { window.nexo.pyIntelReset(); pyJediWarned = false; window.nexo.pyLintReset(state.projectRoot); pyState.tests = null; pyState.testsError = null; pyState.packages = null; }, 8000);
    });
    tool('py-install-ruff', 'ruff');
    tool('py-install-pytest', 'pytest');
    tool('py-install-jedi', 'jedi');
    tool('py-install-debugpy', 'debugpy');
    tool('py-install-black', 'black');
    tool('py-install-nb', 'matplotlib');
    return;
  }

  if (!a) return msg('No Python interpreter available.');

  if (pyState.subtab === 'tests') {
    if (pyState.loading) return msg('Collecting tests…');
    if (pyState.testsError === 'no-pytest') {
      box.innerHTML = '<div id="scripts-empty">pytest is not installed in this environment.</div><div class="py-actions"><button class="tbtn" id="py-get-pytest">Install pytest</button></div>';
      document.getElementById('py-get-pytest')!.addEventListener('click', () => {
        runCommandInTerminal(`${pyQuote(a.bin)} -m pip install pytest`);
        setTimeout(loadPyTests, 8000);
      });
      return;
    }
    if (pyState.testsError) return msg(pyState.testsError);
    if (pyState.tests === null) return msg('Collecting tests…');
    if (!pyState.tests.length) return msg('No tests found.');
    const byFile = new Map();
    for (const id of pyState.tests) {
      const [file, ...rest] = id.split('::');
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push({ id, name: rest.join('::') });
    }
    box.innerHTML = `<div class="outdated-actions"><button class="tbtn" id="py-test-all">▶ Run All (${pyState.tests.length})</button></div>` +
      [...byFile.entries()].map(([file, items]) => `
        <div class="py-section">
          <div class="outdated-row"><div class="outdated-row-main"><div class="outdated-row-name">${escapeHtml(file)}</div></div>
            <button class="script-run-btn" data-test="${escapeHtml(file)}">▶ File</button></div>
          ${items.map((t: any) => `<div class="outdated-row" style="margin-left:10px"><div class="outdated-row-main"><div class="script-row-cmd">${escapeHtml(t.name)}</div></div>
            <button class="script-run-btn" data-test="${escapeHtml(t.id)}">▶</button></div>`).join('')}
        </div>`).join('');
    document.getElementById('py-test-all')!.addEventListener('click', () => runPytest(''));
    box.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => runPytest(b.dataset.test)));
    return;
  }

  if (pyState.error) return msg(pyState.error);

  if (pyState.subtab === 'packages') {
    const header = `
      <div class="script-row-cmd" style="padding:2px 4px 6px">Using: ${escapeHtml(a.label)} · ${escapeHtml(mgr)}</div>
      <div class="py-input-row"><input id="py-pkg-name" placeholder="package (e.g. requests==2.31)" spellcheck="false" /><button class="tbtn" id="py-pkg-install">Install</button></div>`;
    if (pyState.packages === null) box.innerHTML = header + '<div id="scripts-empty">Loading packages…</div>';
    else {
      box.innerHTML = header + (pyState.packages.length ? pyState.packages.map((p: any) => `
        <div class="outdated-row">
          <div class="outdated-row-main">
            <div class="outdated-row-name">${escapeHtml(p.name)}</div>
            <div class="outdated-row-versions">${escapeHtml(p.version)}</div>
          </div>
          <button class="script-run-btn" data-uninstall="${escapeHtml(p.name)}">Remove</button>
        </div>`).join('') : '<div id="scripts-empty">No packages installed.</div>');
    }
    const input = document.getElementById('py-pkg-name');
    const install = () => {
      const v = input!.value.trim();
      if (!pySafeArg(v)) return;
      runCommandInTerminal(pyCmd('install', v));
      input!.value = '';
      pyAfterChange(7000);
    };
    document.getElementById('py-pkg-install')!.addEventListener('click', install);
    input!.addEventListener('keydown', (e) => { if (e.key === 'Enter') install(); });
    box.querySelectorAll('[data-uninstall]').forEach((b) => b.addEventListener('click', () => {
      runCommandInTerminal(pyCmd('remove', b.dataset.uninstall));
      pyAfterChange(5000);
    }));
    return;
  }

  // outdated
  if (pyState.loading || pyState.outdated === null) return msg('Checking for outdated packages…');
  if (!pyState.outdated.length) return msg('Everything is up to date.');
  box.innerHTML = `
    <div class="outdated-actions"><button class="tbtn" id="py-upgrade-all">Upgrade All</button></div>
    ${pyState.outdated.map((p: any) => `
      <div class="outdated-row">
        <div class="outdated-row-main">
          <div class="outdated-row-name">${escapeHtml(p.name)}</div>
          <div class="outdated-row-versions">${escapeHtml(p.version)} → <span class="outdated-latest">${escapeHtml(p.latest_version)}</span></div>
        </div>
        <button class="script-run-btn" data-upgrade="${escapeHtml(p.name)}">Upgrade</button>
      </div>`).join('')}`;
  const after = () => setTimeout(() => { pyState.packages = null; loadPyOutdated(true); }, 9000);
  document.getElementById('py-upgrade-all')!.addEventListener('click', () => {
    const cmds = pyState.outdated.map((p: any) => pyCmd('upgrade', p.name));
    runCommandInTerminal(cmds.join(' && ')); after();
  });
  box.querySelectorAll('[data-upgrade]').forEach((b) => b.addEventListener('click', () => {
    runCommandInTerminal(pyCmd('upgrade', b.dataset.upgrade)); after();
  }));
}

// ---------------- Python debugger (debugpy) ----------------
const breakpoints = new Map(); // file -> Set(line)
let dbg: any = { active: false, stopped: false, frames: [], variables: [], selFrame: 0, evalOut: '' };

function bpLines(file: any) { return [...(breakpoints.get(file) || [])].sort((a, b) => a - b); }

function allBreakpointsObj() {
  const o: any = {};
  for (const [f, set] of breakpoints) if (set.size) o[f] = [...set];
  return o;
}

function refreshDebugDecorations(tab: any) {
  if (!tab || !tab.model || !window.monaco) return;
  const decos = [];
  for (const line of bpLines(tab.path)) {
    decos.push({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: false, glyphMarginClassName: 'dbg-bp-glyph', glyphMarginHoverMessage: { value: 'Breakpoint' } } });
  }
  const f = dbg.stopped && dbg.frames[dbg.selFrame];
  if (f && f.file === tab.path) {
    decos.push({ range: new monaco.Range(f.line, 1, f.line, 1), options: { isWholeLine: true, className: 'dbg-current-line', glyphMarginClassName: 'dbg-current-glyph' } });
  }
  tab.dbgDecos = tab.model.deltaDecorations(tab.dbgDecos || [], decos);
}

function refreshAllDebugDecorations() { state.openTabs.forEach((t) => { if (!t.isImage) refreshDebugDecorations(t); }); }

function toggleBreakpoint(file: any, line: any) {
  if (!breakpoints.has(file)) breakpoints.set(file, new Set());
  const set = breakpoints.get(file);
  if (set.has(line)) set.delete(line); else set.add(line);
  refreshDebugDecorations(state.openTabs.find((t) => t.path === file));
  if (dbg.active) dbgApi().setBreakpoints(file, [...set]);
  renderDebugPanel();
}

function initDebugEditorHooks() {
  editor.onMouseDown((e: any) => {
    if ((e.event.ctrlKey || e.event.metaKey) && e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT && e.target.position) {
      const tabNow = state.openTabs.find((t) => t.path === state.activeTab);
      if (tabNow && /\.pyw?$/i.test(tabNow.path)) { editor.setPosition(e.target.position); pyGoToDefinition(); return; }
    }
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const tab = state.openTabs.find((t) => t.path === state.activeTab);
    if (!tab || !isDebuggablePath(tab.path)) return;
    toggleBreakpoint(tab.path, e.target.position.lineNumber);
  });
  editor.onDidChangeModel(() => {
    const m = editor.getModel();
    refreshDebugDecorations(state.openTabs.find((t) => t.model === m));
  });
}

function dbgTerminal() { return terminals.find((t) => t.activeRunId === 'dbg') || null; }

function setDbgButtons() {
  const on = dbg.active, stopped = dbg.stopped;
  document.getElementById('dbg-start')!.disabled = on;
  ['dbg-continue', 'dbg-over', 'dbg-into', 'dbg-out'].forEach((id) => { document.getElementById(id)!.disabled = !stopped; });
  document.getElementById('dbg-stop')!.disabled = !on;
}

async function startDebug() {
  if (dbg.active) return;
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (!tab || !isDebuggablePath(tab.path)) { flashToast('Open a .py, .js, .mjs, .cjs or .ts file to debug'); return; }
  const kind = isNodeDebugPath(tab.path) ? 'node' : 'py';
  if (!state.projectRoot) return;
  if (tab.modified) await saveActiveTab();
  toggleTerminal(true);
  let t = getActiveTerminal();
  if (t && t.activeRunId) { t = createTerminalSession(); switchTerminalTab(t.id); }
  if (!t) return;
  resetAnsiState(t);
  termAppend(t, `\n[debug] ${tab.path}\n`, 'term-cmd');
  t.activeRunId = 'dbg';
  document.getElementById('term-run-btn')!.textContent = 'Stop';
  renderTerminalTabs();
  dbg = { active: true, kind, stopped: false, frames: [], variables: [], selFrame: 0, evalOut: '' };
  setDbgButtons(); switchRailView('debug'); renderDebugPanel();
  const res = kind === 'node' ? await window.nexo.njsStart(state.projectRoot, tab.path, allBreakpointsObj()) : await window.nexo.dbgStart(state.projectRoot, tab.path, allBreakpointsObj());
  if (!res.ok) {
    endDebugUi(t, null);
    if (kind === 'node') nodeDebugStartFailed(t, res);
    else if (res.reason === 'no-debugpy') {
      termAppend(t, 'debugpy is not installed in this environment.\n', 'term-err');
      if (confirm('debugpy is not installed in the selected Python environment.\n\nInstall it now?')) {
        const r = await window.nexo.pyResolve(state.projectRoot);
        if (r) runCommandInTerminal(`${pyQuote(r.bin)} -m pip install debugpy`);
      }
    } else termAppend(t, `[debug error] ${res.error || 'Could not start debugger.'}\n`, 'term-err');
  }
}

function endDebugUi(t: any, code: any) {
  if (t) {
    if (code !== null) termAppend(t, `[debug session ended]\n`, 'term-exit');
    t.activeRunId = null;
    if (t.id === activeTerminalId) document.getElementById('term-run-btn')!.textContent = 'Run';
    renderTerminalTabs();
  }
  dbg = { active: false, stopped: false, frames: [], variables: [], selFrame: 0, evalOut: '' };
  setDbgButtons(); refreshAllDebugDecorations(); renderDebugPanel();
}

async function showDebugFrame(i: any) {
  const f = dbg.frames[i];
  if (!f) return;
  dbg.selFrame = i;
  if (f.file) {
    await openFile(f.file, { silent: true });
    if (editor) { editor.setPosition({ lineNumber: f.line, column: 1 }); editor.revealLineInCenter(f.line); }
  }
  refreshAllDebugDecorations();
  if (i > 0) {
    const r = await dbgApi().frameVars(f.id);
    if (r.ok) dbg.variables = r.variables;
  }
  renderDebugPanel();
}

window.nexo.onDbgEvent(async (name: any, p: any) => {
  const t = dbgTerminal();
  if (name === 'output') { if (t) termAppendAnsi(t, p.output); return; }
  if (name === 'continued') { dbg.stopped = false; setDbgButtons(); refreshAllDebugDecorations(); renderDebugPanel(); return; }
  if (name === 'stopped') {
    dbg.stopped = true; dbg.frames = p.frames || []; dbg.variables = p.variables || []; dbg.selFrame = 0; dbg.evalOut = '';
    setDbgButtons();
    await showDebugFrame(0);
    return;
  }
  if (name === 'terminated') endDebugUi(t, p.code);
});

function dbgControl(cmd: any) { if (dbg.active && (dbg.stopped || cmd === 'pause')) dbgApi().control(cmd); }
document.getElementById('dbg-start')!.addEventListener('click', startDebug);
document.getElementById('dbg-continue')!.addEventListener('click', () => dbgControl('continue'));
document.getElementById('dbg-over')!.addEventListener('click', () => dbgControl('next'));
document.getElementById('dbg-into')!.addEventListener('click', () => dbgControl('stepIn'));
document.getElementById('dbg-out')!.addEventListener('click', () => dbgControl('stepOut'));
document.getElementById('dbg-stop')!.addEventListener('click', () => dbgApi().stop());
document.getElementById('btn-debug-py')!.addEventListener('click', startDebug);

function renderDebugPanel() {
  const box = document.getElementById('debug-body');
  if (!box) return;
  const bps = [];
  for (const [f, set] of breakpoints) for (const l of [...set].sort((a, b) => a - b)) bps.push({ f, l });
  const rel = (f: any) => (state.projectRoot && f.startsWith(state.projectRoot) ? f.slice(state.projectRoot.length + 1) : f);
  box.innerHTML = `
    <div class="py-section"><div class="py-section-title">Variables</div>
      ${dbg.stopped ? (dbg.variables.length ? dbg.variables.map((v: any) => `<div class="dbg-var" title="${escapeHtml(v.type)}"><span class="dbg-var-name">${escapeHtml(v.name)}</span><span class="dbg-var-val">${escapeHtml(v.value)}</span></div>`).join('') : '<div class="script-row-cmd" style="padding:4px 8px">No locals.</div>')
        : `<div class="script-row-cmd" style="padding:4px 8px">${dbg.active ? 'Running…' : 'Not debugging. Click ● in the editor gutter to set breakpoints, then ▶ Start (F5).'}</div>`}
      ${dbg.stopped ? `<div class="dbg-eval"><input id="dbg-eval-input" placeholder="evaluate expression…" spellcheck="false" /></div><div class="dbg-eval-result">${escapeHtml(dbg.evalOut)}</div>` : ''}
    </div>
    <div class="py-section"><div class="py-section-title">Call stack</div>
      ${dbg.stopped ? dbg.frames.map((f: any, i: any) => `<div class="dbg-frame ${i === dbg.selFrame ? 'current' : ''}" data-frame="${i}"><span>${escapeHtml(f.name)}</span><span class="script-row-cmd">${escapeHtml(f.file ? f.file.split(/[\\/]/).pop() : '')}:${f.line}</span></div>`).join('') : '<div class="script-row-cmd" style="padding:4px 8px">—</div>'}
    </div>
    <div class="py-section"><div class="py-section-title">Breakpoints (${bps.length})</div>
      ${bps.length ? bps.map((b) => `<div class="dbg-bp" data-bp-file="${escapeHtml(b.f)}" data-bp-line="${b.l}"><span>● ${escapeHtml(rel(b.f))}:${b.l}</span><span class="script-row-cmd" data-bp-remove="1" title="Remove">✕</span></div>`).join('') : '<div class="script-row-cmd" style="padding:4px 8px">None</div>'}
    </div>`;
  box.querySelectorAll('[data-frame]').forEach((el) => el.addEventListener('click', () => showDebugFrame(+el.dataset.frame)));
  box.querySelectorAll('.dbg-bp').forEach((el) => el.addEventListener('click', async (e) => {
    const file = el.dataset.bpFile, line = +el.dataset.bpLine;
    if (e.target!.closest('[data-bp-remove]')) { toggleBreakpoint(file, line); return; }
    await openFile(file, { silent: true });
    if (editor) { editor.setPosition({ lineNumber: line, column: 1 }); editor.revealLineInCenter(line); }
  }));
  const input = document.getElementById('dbg-eval-input');
  if (input) input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    const f = dbg.frames[dbg.selFrame];
    const r = await dbgApi().evaluate(input.value.trim(), f && f.id);
    dbg.evalOut = r.ok ? r.result : `Error: ${r.error}`;
    renderDebugPanel();
  });
}

// ---------------- Python IntelliSense (jedi) ----------------
let pyIntelRegistered = false;
let pyJediWarned = false;
const PY_KIND = (): Record<string, any> => ({
  module: monaco.languages.CompletionItemKind.Module, class: monaco.languages.CompletionItemKind.Class,
  instance: monaco.languages.CompletionItemKind.Variable, function: monaco.languages.CompletionItemKind.Function,
  param: monaco.languages.CompletionItemKind.Variable, path: monaco.languages.CompletionItemKind.File,
  keyword: monaco.languages.CompletionItemKind.Keyword, property: monaco.languages.CompletionItemKind.Property,
  statement: monaco.languages.CompletionItemKind.Variable,
});

async function pyIntel(model: any, position: any, op: any) {
  if (!state.projectRoot) return null;
  const tab = state.openTabs.find((t) => t.model === model);
  const res = await window.nexo.pyIntel(state.projectRoot, {
    op, source: model.getValue(), line: position.lineNumber, col: position.column, path: tab ? tab.path : null,
  });
  if (!res.ok) {
    if (res.reason === 'no-jedi' && !pyJediWarned) { pyJediWarned = true; flashToast('Python IntelliSense needs jedi — Python tab → Install jedi'); }
    return null;
  }
  return res.result;
}

function registerPythonIntel() {
  if (pyIntelRegistered || !window.monaco) return;
  pyIntelRegistered = true;
  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.'],
    async provideCompletionItems(model: any, position: any) {
      const items = await pyIntel(model, position, 'complete');
      if (!items) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range: any = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      const kinds = PY_KIND();
      return { suggestions: items.map((c: any) => ({
        label: c.label, kind: kinds[c.kind] ?? monaco.languages.CompletionItemKind.Text,
        detail: c.sig || c.detail, insertText: c.label, range,
      })) };
    },
  });
  monaco.languages.registerHoverProvider('python', {
    async provideHover(model: any, position: any) {
      const h = await pyIntel(model, position, 'hover');
      if (!h) return null;
      const parts = [];
      parts.push({ value: '```python\n' + (h.sig ? `${h.name.split('.').pop()}${h.sig.startsWith('(') ? '' : ': '}${h.sig}` : `(${h.type}) ${h.name}`) + '\n```' });
      if (h.doc) parts.push({ value: h.doc });
      return { contents: parts };
    },
  });
  monaco.languages.registerSignatureHelpProvider('python', {
    signatureHelpTriggerCharacters: ['(', ','],
    async provideSignatureHelp(model: any, position: any) {
      const sigs = await pyIntel(model, position, 'signature');
      if (!sigs || !sigs.length) return null;
      return {
        value: {
          activeSignature: 0, activeParameter: sigs[0].active,
          signatures: sigs.map((s: any) => ({ label: s.label, parameters: s.params.map((p: any) => ({ label: p })) })),
        },
        dispose() {},
      };
    },
  });
}

async function pyGoToDefinition() {
  const model = editor && editor.getModel();
  const tab = model && state.openTabs.find((t) => t.model === model);
  if (!tab || !/\.pyw?$/i.test(tab.path)) return;
  const defs = await pyIntel(model, editor.getPosition(), 'define');
  if (!defs || !defs.length) { flashToast('No definition found'); return; }
  const d = defs[0];
  await openFile(d.path, { silent: true });
  if (editor) { editor.setPosition({ lineNumber: d.line, column: d.col }); editor.revealLineInCenter(d.line); }
}

// ---------------- Jupyter notebooks (.ipynb) ----------------
const isNotebookPath = (p: any) => /\.ipynb$/i.test(p || '');
let nbBusy = false;

function nbJoin(v: any) { return Array.isArray(v) ? v.join('') : (v || ''); }
function nbSplitLines(s: any) { const parts = (s || '').split('\n'); return parts.map((l: any, i: any) => (i < parts.length - 1 ? l + '\n' : l)).filter((l: any, i: any, a: any) => !(i === a.length - 1 && l === '')); }
function nbStripAnsi(s: any) { return String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''); }
function nbNewId() { return Math.random().toString(36).slice(2, 10); }

function nbParse(tab: any) {
  let raw;
  try { raw = JSON.parse(tab.model.getValue() || '{}'); } catch { return null; }
  const cells = (raw.cells || []).map((c: any) => ({
    id: c.id || nbNewId(), cell_type: c.cell_type === 'markdown' ? 'markdown' : (c.cell_type === 'raw' ? 'raw' : 'code'),
    source: nbJoin(c.source), outputs: c.outputs || [], execution_count: c.execution_count ?? null, metadata: c.metadata || {},
  }));
  return { raw, cells };
}

function nbSerialize(tab: any) {
  const nb = tab.nb;
  const out = { ...nb.raw, nbformat: nb.raw.nbformat || 4, nbformat_minor: nb.raw.nbformat_minor ?? 5, metadata: nb.raw.metadata || {} };
  out.cells = nb.cells.map((c: any) => {
    const base: any = { cell_type: c.cell_type, id: c.id, metadata: c.metadata || {}, source: nbSplitLines(c.source) };
    if (c.cell_type === 'code') { base.outputs = c.outputs; base.execution_count = c.execution_count; }
    return base;
  });
  return JSON.stringify(out, null, 1) + '\n';
}

let nbSyncTimers = new Map();
function nbSync(tab: any, immediate = false) {
  clearTimeout(nbSyncTimers.get(tab.path));
  const go = () => {
    if (!tab.model) return;
    tab.nbSelfEdit = true;
    tab.model.setValue(nbSerialize(tab));
    tab.nbVersion = tab.model.getAlternativeVersionId();
    tab.nbSelfEdit = false;
    if (!tab.modified) { tab.modified = true; renderTabs(); }
    maybeAutoSave(tab.path);
  };
  if (immediate) go(); else nbSyncTimers.set(tab.path, setTimeout(go, 300));
}

function nbRenderOutput(o: any) {
  const wrap = document.createElement('div');
  wrap.className = 'nb-out';
  if (o.output_type === 'stream') {
    const pre = document.createElement('pre'); pre.className = o.name === 'stderr' ? 'nb-stderr' : ''; pre.textContent = nbStripAnsi(nbJoin(o.text)); wrap.appendChild(pre);
  } else if (o.output_type === 'error') {
    const pre = document.createElement('pre'); pre.className = 'nb-error'; pre.textContent = nbStripAnsi((o.traceback || []).join('\n') || `${o.ename}: ${o.evalue}`); wrap.appendChild(pre);
  } else {
    const d = o.data || {};
    if (d['image/png']) { const img = document.createElement('img'); img.src = 'data:image/png;base64,' + nbJoin(d['image/png']).replace(/\n/g, ''); wrap.appendChild(img); }
    else if (d['text/html']) { const div = document.createElement('div'); div.className = 'nb-html'; const h = nbJoin(d['text/html']); div.innerHTML = window.DOMPurify ? DOMPurify.sanitize(h) : escapeHtml(h); wrap.appendChild(div); }
    else { const pre = document.createElement('pre'); pre.textContent = nbStripAnsi(nbJoin(d['text/plain'])); wrap.appendChild(pre); }
  }
  return wrap;
}

function nbFillOutputs(el: any, cell: any) {
  el.innerHTML = '';
  (cell.outputs || []).forEach((o: any) => el.appendChild(nbRenderOutput(o)));
}

function nbAutosize(ta: any) { ta.style.height = 'auto'; ta.style.height = Math.max(36, ta.scrollHeight + 2) + 'px'; }

async function nbRunCell(tab: any, cell: any, cellEl: any) {
  if (cell.cell_type !== 'code') return;
  const root = state.projectRoot;
  if (!root) return;
  cellEl.classList.add('running');
  cellEl.querySelector('.nb-prompt').textContent = '[*]';
  const res = await window.nexo.nbRun(root, tab.path, cell.source);
  cellEl.classList.remove('running');
  if (!res.ok) { cell.outputs = [{ output_type: 'error', ename: 'Error', evalue: res.error, traceback: [res.error] }]; cell.execution_count = null; }
  else { cell.outputs = res.outputs; cell.execution_count = res.count; }
  cellEl.querySelector('.nb-prompt').textContent = `[${cell.execution_count ?? ' '}]`;
  nbFillOutputs(cellEl.querySelector('.nb-outputs'), cell);
  nbSync(tab);
}

async function nbRunAll(tab: any) {
  if (nbBusy) return;
  nbBusy = true;
  try {
    const els = [...document.querySelectorAll('#notebook-cells .nb-cell')];
    for (let i = 0; i < tab.nb.cells.length; i++) await nbRunCell(tab, tab.nb.cells[i], els[i]);
  } finally { nbBusy = false; }
}

function renderNotebook(tab: any) {
  const view = document.getElementById('notebook-view');
  const cellsBox = document.getElementById('notebook-cells');
  if (!tab.nb || tab.nbVersion !== tab.model.getAlternativeVersionId()) {
    const parsed = nbParse(tab);
    if (!parsed) { tab.nbMode = 'json'; flashToast('Not a valid notebook — showing JSON'); activateTab(tab.path); return; }
    tab.nb = parsed; tab.nbVersion = tab.model.getAlternativeVersionId();
  }
  view!.style.display = 'flex';
  document.getElementById('notebook-title')!.textContent = tab.name;
  cellsBox!.innerHTML = '';
  const nb = tab.nb;

  const addCell = (type: any, at: any) => {
    nb.cells.splice(at, 0, { id: nbNewId(), cell_type: type, source: '', outputs: [], execution_count: null, metadata: {} });
    nbSync(tab, true); renderNotebook(tab);
  };

  nb.cells.forEach((cell: any, idx: any) => {
    const el = document.createElement('div');
    el.className = `nb-cell nb-${cell.cell_type}`;
    el.innerHTML = `
      <div class="nb-side"><div class="nb-prompt">${cell.cell_type === 'code' ? `[${cell.execution_count ?? ' '}]` : ''}</div>${cell.cell_type === 'code' ? '<button class="nb-btn nb-run" title="Run (Ctrl+Enter)">▶</button>' : ''}</div>
      <div class="nb-main">
        <div class="nb-md-view"></div>
        <textarea class="nb-input" spellcheck="false" placeholder="${cell.cell_type === 'code' ? 'Python code…' : 'Markdown…'}"></textarea>
        <div class="nb-outputs"></div>
      </div>
      <div class="nb-actions">
        <button class="nb-btn" data-act="up" title="Move up">↑</button><button class="nb-btn" data-act="down" title="Move down">↓</button>
        <button class="nb-btn" data-act="type" title="Toggle code/markdown">${cell.cell_type === 'code' ? 'M↓' : '{ }'}</button>
        <button class="nb-btn" data-act="above" title="Add code cell above">+↑</button><button class="nb-btn" data-act="below" title="Add code cell below">+↓</button>
        <button class="nb-btn" data-act="del" title="Delete cell">🗑</button>
      </div>`;
    const ta = el.querySelector('.nb-input');
    const mdView = el.querySelector('.nb-md-view');
    ta!.value = cell.source;
    const showMd = () => {
      if (cell.cell_type !== 'markdown') { mdView!.style.display = 'none'; ta!.style.display = 'block'; return; }
      const raw = typeof marked !== 'undefined' ? marked.parse(cell.source || '*empty markdown cell*') : escapeHtml(cell.source);
      mdView!.innerHTML = window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
      mdView!.style.display = 'block'; ta!.style.display = 'none';
    };
    showMd();
    mdView!.addEventListener('dblclick', () => { mdView!.style.display = 'none'; ta!.style.display = 'block'; nbAutosize(ta); ta!.focus(); });
    nbFillOutputs(el.querySelector('.nb-outputs'), cell);
    setTimeout(() => nbAutosize(ta), 0);
    ta!.addEventListener('input', () => { cell.source = ta!.value; nbAutosize(ta); nbSync(tab); });
    const focusCell = (i: any) => { const t = cellsBox!.querySelectorAll('.nb-input')[i]; if (t) { const cEl = t.closest('.nb-cell'); if (cEl!.classList.contains('nb-markdown')) cEl!.querySelector('.nb-md-view')!.dispatchEvent(new Event('dblclick')); else t.focus(); } };
    ta!.addEventListener('keydown', async (e) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const s = ta!.selectionStart;
        ta!.value = ta!.value.slice(0, s) + '    ' + ta!.value.slice(ta!.selectionEnd);
        ta!.selectionStart = ta!.selectionEnd = s + 4;
        ta!.dispatchEvent(new Event('input'));
      } else if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (cell.cell_type === 'code') await nbRunCell(tab, cell, el); else showMd();
        if (e.shiftKey) { if (idx === nb.cells.length - 1) addCell('code', idx + 1); else focusCell(idx + 1); }
      }
    });
    const runBtn = el.querySelector('.nb-run');
    if (runBtn) runBtn.addEventListener('click', () => nbRunCell(tab, cell, el));
    el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'up' && idx > 0) { [nb.cells[idx - 1], nb.cells[idx]] = [nb.cells[idx], nb.cells[idx - 1]]; }
      else if (act === 'down' && idx < nb.cells.length - 1) { [nb.cells[idx + 1], nb.cells[idx]] = [nb.cells[idx], nb.cells[idx + 1]]; }
      else if (act === 'type') { cell.cell_type = cell.cell_type === 'code' ? 'markdown' : 'code'; if (cell.cell_type === 'markdown') { cell.outputs = []; cell.execution_count = null; } }
      else if (act === 'above') { addCell('code', idx); return; }
      else if (act === 'below') { addCell('code', idx + 1); return; }
      else if (act === 'del') { nb.cells.splice(idx, 1); }
      else return;
      nbSync(tab, true); renderNotebook(tab);
    }));
    cellsBox!.appendChild(el);
  });
  if (!nb.cells.length) {
    const empty = document.createElement('div'); empty.id = 'scripts-empty'; empty.textContent = 'Empty notebook — add a cell with the buttons above.'; cellsBox!.appendChild(empty);
  }
  view!.dataset.addCode = '1';
  document.getElementById('nb-add-code')!.onclick = () => addCell('code', nb.cells.length);
  document.getElementById('nb-add-md')!.onclick = () => addCell('markdown', nb.cells.length);
  document.getElementById('nb-run-all')!.onclick = () => nbRunAll(tab);
  document.getElementById('nb-restart')!.onclick = async () => { await window.nexo.nbRestart(tab.path); flashToast('Kernel restarted'); };
  document.getElementById('nb-clear')!.onclick = () => { nb.cells.forEach((c: any) => { c.outputs = []; c.execution_count = null; }); nbSync(tab, true); renderNotebook(tab); };
  document.getElementById('nb-json')!.onclick = () => { tab.nbMode = 'json'; activateTab(tab.path); };
}

document.getElementById('md-nb-ui-btn')!.addEventListener('click', () => {
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (tab) { tab.nbMode = 'ui'; activateTab(tab.path); }
});

// ---------------- Python linting (ruff / flake8) ----------------
const noPyLintProjects = new Set();
let pyLintTimer = null;
async function lintPythonFile(filePath: any) {
  if (!state.projectRoot || noPyLintProjects.has(state.projectRoot) || !monacoLoaded) return;
  const tab = state.openTabs.find((t) => t.path === filePath);
  if (!tab) return;
  const lang = tab.model.getLanguageId ? tab.model.getLanguageId() : '';
  if (lang !== 'python') { monaco.editor.setModelMarkers(tab.model, 'python-lint', []); return; }
  const res = await window.nexo.pyLint(state.projectRoot, filePath, tab.model.getValue());
  const stillOpen = state.openTabs.find((t) => t.path === filePath);
  if (!stillOpen) return;
  if (!res.ok) { if (res.reason === 'not-found') noPyLintProjects.add(state.projectRoot); return; }
  monaco.editor.setModelMarkers(stillOpen.model, 'python-lint', res.messages.map((m: any) => ({
    startLineNumber: m.line, startColumn: m.column, endLineNumber: m.endLine, endColumn: m.endColumn,
    message: m.code ? `${m.message} (${m.code})` : m.message,
    severity: m.severity === 2 ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
    source: res.tool,
  })));
}
