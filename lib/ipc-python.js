'use strict';
// Python (venv/lint/format/IntelliSense), notebook kernels, Python debugger and ESLint IPC.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function register({ ipcMain, getWindow, pythonEnvFor, findLocalEslintBin, OUTDATED_CACHE_TTL_MS }) {
  // ---------------- Python support ----------------
  const PY_VENV_DIRS = ['.venv', 'venv', 'env', '.env'];
  const pyCache = new Map(); // "root|bin" -> { result, timestamp }
  const pySelection = new Map(); // projectRoot -> selected venv dir name
  const pyMissingTools = new Set(); // "root|tool" known to be absent

  function venvBinDir(root, dir) {
    return path.join(root, dir, process.platform === 'win32' ? 'Scripts' : 'bin');
  }

  function venvPython(root, dir) {
    const p = path.join(venvBinDir(root, dir), process.platform === 'win32' ? 'python.exe' : 'python');
    return fs.existsSync(p) ? p : null;
  }

  // The venv commands should run in: explicit selection, else the first one found.
  function resolveVenvDir(root) {
    const sel = pySelection.get(root);
    if (sel && venvPython(root, sel)) return sel;
    return PY_VENV_DIRS.find((d) => venvPython(root, d)) || null;
  }

  function runPy(bin, args, cwd, timeout = 20000, input = null) {
    return new Promise((resolve) => {
      const child = execFile(bin, args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ err, stdout: stdout || '', stderr: stderr || '' });
      });
      if (input !== null && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    });
  }

  async function findSystemPython(cwd) {
    const candidates = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
    for (const c of candidates) {
      const r = await runPy(c, ['--version'], cwd, 5000);
      if (!r.err) return { bin: c, version: (r.stdout || r.stderr).trim() };
    }
    return null;
  }

  function detectPyManager(root) {
    const has = (f) => fs.existsSync(path.join(root, f));
    let pyproject = '';
    try { pyproject = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8'); } catch { /* none */ }
    if (has('uv.lock') || /\[tool\.uv\b/.test(pyproject)) return 'uv';
    if (has('poetry.lock') || /\[tool\.poetry\b/.test(pyproject)) return 'poetry';
    if (has('Pipfile')) return 'pipenv';
    return 'pip';
  }

  async function resolveInterpreter(root) {
    const dir = resolveVenvDir(root);
    if (dir) return { bin: venvPython(root, dir), venv: dir };
    const sys = await findSystemPython(root);
    return sys ? { bin: sys.bin, venv: null } : null;
  }

  // pip, falling back to `uv pip` for venvs created by uv (which ship without pip).
  async function runPip(bin, pipArgs, cwd, timeout) {
    const r = await runPy(bin, ['-m', 'pip', ...pipArgs, '--disable-pip-version-check'], cwd, timeout);
    if (r.err && /No module named pip/i.test(r.stderr)) {
      const u = await runPy('uv', ['pip', ...pipArgs, '--python', bin], cwd, timeout);
      if (!u.err || u.stdout) return u;
    }
    return r;
  }

  ipcMain.handle('py:info', async (evt, projectRoot) => {
    if (!projectRoot) return { ok: false, error: 'No project open.' };
    const system = await findSystemPython(projectRoot);
    const venvs = [];
    for (const dir of PY_VENV_DIRS) {
      const bin = venvPython(projectRoot, dir);
      if (!bin) continue;
      const r = await runPy(bin, ['--version'], projectRoot, 5000);
      venvs.push({ dir, bin, version: r.err ? '' : (r.stdout || r.stderr).trim() });
    }
    const files = ['requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'poetry.lock', 'uv.lock']
      .filter((f) => fs.existsSync(path.join(projectRoot, f)));
    return { ok: true, system, venvs, files, selected: resolveVenvDir(projectRoot), manager: detectPyManager(projectRoot), platform: process.platform };
  });

  ipcMain.handle('py:select', (evt, projectRoot, dir) => {
    if (pySelection.get(projectRoot) !== dir) stopIntel();
    if (projectRoot) { if (dir) pySelection.set(projectRoot, dir); else pySelection.delete(projectRoot); }
    return { ok: true };
  });

  ipcMain.handle('py:resolve', async (evt, projectRoot) => {
    if (!projectRoot) return null;
    const it = await resolveInterpreter(projectRoot);
    if (!it) return null;
    const r = await runPy(it.bin, ['--version'], projectRoot, 5000);
    return { bin: it.bin, venv: it.venv, version: r.err ? '' : (r.stdout || r.stderr).trim() };
  });

  ipcMain.handle('py:list', async (evt, projectRoot, pythonBin) => {
    if (!projectRoot || !pythonBin) return { ok: false, error: 'No interpreter.' };
    const r = await runPip(pythonBin, ['list', '--format=json'], projectRoot);
    if (r.err && !r.stdout) return { ok: false, error: r.stderr || r.err.message };
    try { return { ok: true, packages: JSON.parse(r.stdout) }; }
    catch { return { ok: false, error: 'Could not parse pip list output.' }; }
  });

  ipcMain.handle('py:outdated', async (evt, projectRoot, pythonBin, forceRefresh = false) => {
    if (!projectRoot || !pythonBin) return { ok: false, error: 'No interpreter.' };
    const key = projectRoot + '|' + pythonBin;
    const cached = pyCache.get(key);
    if (!forceRefresh && cached && Date.now() - cached.timestamp < OUTDATED_CACHE_TTL_MS) return cached.result;
    const r = await runPip(pythonBin, ['list', '--outdated', '--format=json'], projectRoot, 60000);
    let result;
    if (r.err && !r.stdout) result = { ok: false, error: r.stderr || r.err.message };
    else {
      try { result = { ok: true, packages: JSON.parse(r.stdout) }; }
      catch { result = { ok: false, error: 'Could not parse pip outdated output.' }; }
    }
    if (result.ok) pyCache.set(key, { result, timestamp: Date.now() });
    return result;
  });

  // Lint with ruff (preferred) or flake8 from the project's interpreter.
  ipcMain.handle('py:lint', async (evt, projectRoot, filePath, content) => {
    if (!projectRoot) return { ok: false, reason: 'not-found' };
    const it = await resolveInterpreter(projectRoot);
    if (!it) return { ok: false, reason: 'not-found' };
    const missing = (r) => r.err && /No module named/i.test(r.stderr);
    if (!pyMissingTools.has(projectRoot + '|ruff')) {
      const r = await runPy(it.bin, ['-m', 'ruff', 'check', '--output-format=json', '--no-cache', '--stdin-filename', filePath, '-'], projectRoot, 15000, content);
      if (missing(r)) pyMissingTools.add(projectRoot + '|ruff');
      else {
        try {
          const data = JSON.parse(r.stdout || '[]');
          return { ok: true, tool: 'ruff', messages: data.map((m) => ({
            line: m.location.row, column: m.location.column,
            endLine: (m.end_location || m.location).row, endColumn: (m.end_location || m.location).column,
            message: m.message, code: m.code || '', severity: m.code && /^(E9|F6|F7|F82)/.test(m.code) ? 2 : 1,
          })) };
        } catch { return { ok: false, reason: 'error' }; }
      }
    }
    if (!pyMissingTools.has(projectRoot + '|flake8')) {
      const r = await runPy(it.bin, ['-m', 'flake8', '--format=%(row)d:%(col)d:%(code)s:%(text)s', '--stdin-display-name', filePath, '-'], projectRoot, 15000, content);
      if (missing(r)) pyMissingTools.add(projectRoot + '|flake8');
      else {
        const messages = [];
        for (const line of r.stdout.split(/\r?\n/)) {
          const m = line.match(/^(\d+):(\d+):(\w+):(.*)$/);
          if (m) messages.push({ line: +m[1], column: +m[2], endLine: +m[1], endColumn: +m[2] + 1, message: m[4].trim(), code: m[3], severity: /^(E9|F)/.test(m[3]) ? 2 : 1 });
        }
        return { ok: true, tool: 'flake8', messages };
      }
    }
    return { ok: false, reason: 'not-found' };
  });

  ipcMain.handle('py:format', async (evt, projectRoot, filePath, content) => {
    if (!projectRoot) return { ok: false, reason: 'not-found' };
    const it = await resolveInterpreter(projectRoot);
    if (!it) return { ok: false, reason: 'not-found' };
    const attempts = [
      ['-m', 'ruff', 'format', '--stdin-filename', filePath, '-'],
      ['-m', 'black', '-q', '--stdin-filename', filePath, '-'],
    ];
    for (const args of attempts) {
      const r = await runPy(it.bin, args, projectRoot, 15000, content);
      if (/No module named/i.test(r.stderr)) continue;
      if (r.err) return { ok: false, reason: 'error', error: r.stderr };
      return { ok: true, formatted: r.stdout };
    }
    return { ok: false, reason: 'not-found' };
  });

  // ---------------- Python IntelliSense (jedi helper process) ----------------
  const { spawn: spawnProc } = require('child_process');
  let intelProc = null; // { key, child, pending: Map, nextId, buf, dead }

  function stopIntel() {
    if (intelProc) { try { intelProc.child.kill(); } catch { /* gone */ } intelProc = null; }
  }

  async function ensureIntel(root) {
    const it = await resolveInterpreter(root);
    if (!it) return null;
    const key = root + '|' + it.bin;
    if (intelProc && intelProc.key === key && !intelProc.dead) return intelProc;
    stopIntel();
    const child = spawnProc(it.bin, [path.join(__dirname, 'nexo_jedi.py'), root], { cwd: root, env: pythonEnvFor(root), windowsHide: true });
    const st = { key, child, pending: new Map(), nextId: 1, buf: '', dead: false, noJedi: false };
    child.stdout.on('data', (d) => {
      st.buf += d.toString();
      let i;
      while ((i = st.buf.indexOf('\n')) !== -1) {
        const line = st.buf.slice(0, i); st.buf = st.buf.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id === 0 && msg.error === 'no-jedi') { st.noJedi = true; continue; }
          const p = st.pending.get(msg.id);
          if (p) { st.pending.delete(msg.id); p(msg.result); }
        } catch { /* ignore junk */ }
      }
    });
    child.stderr.on('data', () => {});
    child.on('close', () => { st.dead = true; for (const p of st.pending.values()) p(null); st.pending.clear(); });
    child.on('error', () => { st.dead = true; });
    intelProc = st;
    return st;
  }

  ipcMain.handle('py:intel', async (evt, projectRoot, req) => {
    if (!projectRoot) return { ok: false };
    const st = await ensureIntel(projectRoot);
    if (!st) return { ok: false, reason: 'no-python' };
    // give the helper a moment to report a missing jedi install
    if (st.noJedi || st.dead) return { ok: false, reason: 'no-jedi' };
    const id = st.nextId++;
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => { st.pending.delete(id); resolve(null); }, 8000);
      st.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      try { st.child.stdin.write(JSON.stringify({ ...req, id }) + '\n'); } catch { clearTimeout(timer); resolve(null); }
    });
    if (st.noJedi || st.dead) return { ok: false, reason: 'no-jedi' };
    return { ok: true, result };
  });

  ipcMain.handle('py:intel-reset', () => { stopIntel(); return { ok: true }; });

  // ---------------- Notebook kernels ----------------
  const kernels = new Map(); // notebook path -> { child, buf, pending: Map, nextId, ready }

  function killKernel(nbPath) {
    const k = kernels.get(nbPath);
    if (!k) return;
    kernels.delete(nbPath);
    try { k.child.kill(); } catch { /* gone */ }
    for (const p of k.pending.values()) p({ outputs: [{ output_type: 'error', ename: 'KernelRestarted', evalue: '', traceback: ['Kernel stopped.'] }], count: null });
    k.pending.clear();
  }

  async function ensureKernel(root, nbPath) {
    let k = kernels.get(nbPath);
    if (k) return k;
    const it = await resolveInterpreter(root);
    if (!it) return null;
    const child = spawnProc(it.bin, ['-u', path.join(__dirname, 'nexo_kernel.py')], { cwd: root, env: pythonEnvFor(root), windowsHide: true });
    k = { child, buf: '', pending: new Map(), nextId: 1 };
    child.stdout.on('data', (d) => {
      k.buf += d.toString();
      let i;
      while ((i = k.buf.indexOf('\n')) !== -1) {
        const line = k.buf.slice(0, i); k.buf = k.buf.slice(i + 1);
        const at = line.indexOf('\x01NEXO:');
        if (at === -1) continue;
        try {
          const msg = JSON.parse(line.slice(at + 6));
          const p = k.pending.get(msg.id);
          if (p) { k.pending.delete(msg.id); p(msg); }
        } catch { /* ignore */ }
      }
    });
    child.stderr.on('data', () => {});
    child.on('close', () => {
      if (kernels.get(nbPath) === k) kernels.delete(nbPath);
      for (const p of k.pending.values()) p({ outputs: [{ output_type: 'error', ename: 'KernelDied', evalue: '', traceback: ['The kernel process exited.'] }], count: null });
      k.pending.clear();
    });
    child.on('error', () => {});
    kernels.set(nbPath, k);
    return k;
  }

  ipcMain.handle('nb:run', async (evt, projectRoot, nbPath, code) => {
    const k = await ensureKernel(projectRoot, nbPath);
    if (!k) return { ok: false, error: 'Python not found.' };
    const id = k.nextId++;
    const res = await new Promise((resolve) => {
      k.pending.set(id, resolve);
      try { k.child.stdin.write(JSON.stringify({ id, code }) + '\n'); } catch { resolve(null); }
    });
    if (!res) return { ok: false, error: 'Could not reach the kernel.' };
    return { ok: true, outputs: res.outputs, count: res.count };
  });
  ipcMain.handle('nb:restart', (evt, nbPath) => { killKernel(nbPath); return { ok: true }; });

  ipcMain.handle('py:lint-reset', (evt, projectRoot) => {
    for (const k of [...pyMissingTools]) if (k.startsWith(projectRoot + '|')) pyMissingTools.delete(k);
    return { ok: true };
  });

  // Collect pytest tests: returns node ids like tests/test_a.py::test_x
  ipcMain.handle('py:tests', async (evt, projectRoot) => {
    if (!projectRoot) return { ok: false, error: 'No project open.' };
    const it = await resolveInterpreter(projectRoot);
    if (!it) return { ok: false, error: 'No Python interpreter found.' };
    const r = await runPy(it.bin, ['-m', 'pytest', '--collect-only', '-q', '--no-header', '-p', 'no:cacheprovider'], projectRoot, 30000);
    if (/No module named pytest/i.test(r.stderr + r.stdout)) return { ok: false, reason: 'no-pytest' };
    const tests = r.stdout.split(/\r?\n/).filter((l) => l.includes('::') && !/^\s/.test(l) && !/^(ERROR|FAILED)/.test(l));
    if (!tests.length && r.err && r.err.code !== 5) return { ok: false, error: (r.stdout + r.stderr).trim().slice(0, 600) || r.err.message };
    return { ok: true, tests };
  });

  // ---------------- Python debugger ----------------
  const { PyDebugSession } = require('./pydebug');
  let dbgSession = null;

  function dbgSend(name, payload) {
    if (getWindow() && !getWindow().isDestroyed()) getWindow().webContents.send('dbg:event', name, payload);
  }

  ipcMain.handle('dbg:start', async (evt, projectRoot, file, breakpoints) => {
    if (dbgSession) { try { dbgSession.stop(); } catch { /* gone */ } dbgSession = null; }
    const it = await resolveInterpreter(projectRoot);
    if (!it) return { ok: false, error: 'Python not found.' };
    const session = new PyDebugSession({
      python: it.bin, file, cwd: projectRoot, env: pythonEnvFor(projectRoot), breakpoints,
      onEvent: (name, payload) => { if (dbgSession === session || name === 'terminated') dbgSend(name, payload); },
    });
    dbgSession = session;
    try {
      await session.start();
      return { ok: true };
    } catch (err) {
      dbgSession = null;
      session.stop();
      return { ok: false, reason: err.message === 'no-debugpy' ? 'no-debugpy' : 'error', error: err.message };
    }
  });
  ipcMain.handle('dbg:control', async (evt, cmd) => { if (dbgSession) { try { await dbgSession.control(cmd); } catch { /* ignore */ } } return { ok: true }; });
  ipcMain.handle('dbg:stop', () => { if (dbgSession) { dbgSession.stop(); dbgSession = null; } return { ok: true }; });
  ipcMain.handle('dbg:write', (evt, text) => { if (dbgSession) dbgSession.write(text); return { ok: true }; });
  ipcMain.handle('dbg:set-breakpoints', async (evt, file, lines) => { if (dbgSession) { try { await dbgSession.setBreakpoints(file, lines); } catch { /* ignore */ } } return { ok: true }; });
  ipcMain.handle('dbg:frame-vars', async (evt, frameId) => {
    if (!dbgSession) return { ok: false };
    try { return { ok: true, variables: await dbgSession.frameVariables(frameId) }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('dbg:eval', async (evt, expr, frameId) => {
    if (!dbgSession) return { ok: false, error: 'No active debug session.' };
    try { return { ok: true, result: await dbgSession.evaluate(expr, frameId) }; } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('eslint:lint', async (evt, projectRoot, filePath, content) => {
    if (!projectRoot) return { ok: false, reason: 'not-found' };
    const bin = findLocalEslintBin(projectRoot);
    if (!bin) return { ok: false, reason: 'not-found' };
    const useStdin = typeof content === 'string';
    const args = useStdin
      ? ['--format', 'json', '--no-color', '--stdin', '--stdin-filename', filePath]
      : ['--format', 'json', '--no-color', filePath];
    return new Promise((resolve) => {
      const child = execFile(bin, args, { cwd: projectRoot, timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        // ESLint exits with code 1 when it finds lint problems — that's not a
        // real failure, stdout still has valid JSON either way.
        if (!stdout) { resolve({ ok: false, reason: 'error', error: err ? err.message : 'No output from ESLint.' }); return; }
        try {
          const results = JSON.parse(stdout);
          const resolved = path.resolve(filePath);
          const fileResult = results.find((r) => path.resolve(r.filePath) === resolved) || results[0];
          const messages = fileResult ? fileResult.messages : [];
          resolve({
            ok: true,
            messages: messages
              .filter((m) => Number.isFinite(m.line)) // fatal parse errors sometimes omit position info
              .map((m) => ({
                line: m.line, column: m.column || 1,
                endLine: m.endLine || m.line, endColumn: m.endColumn || (m.column || 1) + 1,
                severity: m.severity, message: m.message, ruleId: m.ruleId || null,
              })),
          });
        } catch {
          resolve({ ok: false, reason: 'error', error: 'Could not parse ESLint output.' });
        }
      });
      if (useStdin) {
        child.stdin.write(content);
        child.stdin.end();
      }
    });
  });
  function shutdown() {
    for (const p of [...kernels.keys()]) killKernel(p);
    stopIntel();
    if (dbgSession) { try { dbgSession.stop(); } catch { /* gone */ } }
  }
  return { shutdown, resolveVenvDir, venvBinDir };
}

module.exports = { register };
