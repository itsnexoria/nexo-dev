'use strict';
// Pure task-detection and problem-matching helpers (UMD: loaded by node tests and bundled into the renderer).
(function (root) {
  const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
  const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

  // JSON with // and /* */ comments and trailing commas (VS Code's tasks.json).
  function parseJsonc(text) {
    let out = '', i = 0, inStr = false;
    const s = String(text);
    while (i < s.length) {
      const c = s[i], n = s[i + 1];
      if (inStr) { out += c; if (c === '\\') { out += n || ''; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
      out += c; i++;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  }

  const quoteArg = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : '"' + String(a).replace(/(["\\$`])/g, '\\$1') + '"');

  // sources: { packageJson?: object, packageManager?: 'npm'|'pnpm'|'yarn'|'bun', nexoTasks?: object, vscodeTasks?: object }
  function detectTasks(src = {}) {
    const tasks = [];
    const pm = ['npm', 'pnpm', 'yarn', 'bun'].includes(src.packageManager) ? src.packageManager : 'npm';
    const scripts = src.packageJson && typeof src.packageJson.scripts === 'object' && src.packageJson.scripts ? src.packageJson.scripts : {};
    for (const name of Object.keys(scripts)) {
      if (typeof scripts[name] !== 'string') continue;
      tasks.push({ id: 'npm:' + name, label: name, command: pm === 'yarn' ? `yarn ${name}` : `${pm} run ${name}`, source: 'package.json', matcher: /tsc|typecheck/.test(scripts[name]) ? 'tsc' : /eslint|lint/.test(scripts[name]) ? 'eslint' : 'auto' });
    }
    const add = (list, source) => {
      if (!list || !Array.isArray(list.tasks)) return;
      for (const t of list.tasks) {
        if (!t || typeof t.label !== 'string' || !t.label) continue;
        let cmd = typeof t.command === 'string' ? t.command : '';
        if (!cmd) continue;
        if (Array.isArray(t.args)) cmd += ' ' + t.args.filter((a) => typeof a === 'string' || typeof a === 'number').map((a) => quoteArg(String(a))).join(' ');
        const pmName = typeof t.problemMatcher === 'string' ? t.problemMatcher.replace(/^\$/, '') : (Array.isArray(t.problemMatcher) && typeof t.problemMatcher[0] === 'string' ? t.problemMatcher[0].replace(/^\$/, '') : 'auto');
        tasks.push({ id: source + ':' + t.label, label: t.label, command: cmd.trim(), source, matcher: MATCHERS[pmName] ? pmName : 'auto' });
      }
    };
    add(src.nexoTasks, '.nexo/tasks.json');
    add(src.vscodeTasks, '.vscode/tasks.json');
    return tasks;
  }

  const SEV = (w) => (/warn/i.test(w || '') ? 'warning' : /note|info|hint/i.test(w || '') ? 'info' : 'error');
  // Each matcher: line -> { file, line, col, severity, message } | null  (stateful ones use ctx)
  const MATCHERS = {
    tsc: (l) => { const m = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(l); return m && { file: m[1], line: +m[2], col: +m[3], severity: SEV(m[4]), message: `${m[6]} (${m[5]})` }; },
    gcc: (l) => { const m = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/.exec(l); return m && { file: m[1], line: +m[2], col: +(m[3] || 1), severity: SEV(m[4]), message: m[5] }; },
    eslint: (l, ctx) => {
      if (/^(\/|[A-Za-z]:[\\/]).+/.test(l) && !/\s{2,}/.test(l) && !/^\s/.test(l)) { ctx.file = l.trim(); return null; }
      const m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}(\S+))?$/.exec(l);
      return m && ctx.file ? { file: ctx.file, line: +m[1], col: +m[2], severity: SEV(m[3]), message: m[5] ? `${m[4]} (${m[5]})` : m[4] } : null;
    },
    python: (l, ctx) => {
      const f = /^\s*File "(.+)", line (\d+)/.exec(l);
      if (f) { ctx.pyFile = f[1]; ctx.pyLine = +f[2]; return null; }
      const e = /^([A-Za-z_][\w.]*(?:Error|Exception|Warning)): (.*)$/.exec(l);
      return e && ctx.pyFile ? { file: ctx.pyFile, line: ctx.pyLine, col: 1, severity: 'error', message: `${e[1]}: ${e[2]}` } : null;
    },
    generic: (l) => { const m = /^(\S[^:\n]*?\.[A-Za-z0-9]+):(\d+):(\d+):?\s*(error|warning)?:?\s*(.+)$/.exec(l); return m && { file: m[1], line: +m[2], col: +m[3], severity: SEV(m[4]), message: m[5] }; },
  };
  const AUTO = ['tsc', 'gcc', 'python', 'eslint', 'generic'];

  const isAbs = (p) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
  function resolvePath(file, cwd) {
    if (isAbs(file) || !cwd) return file;
    const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/';
    const parts = (cwd.replace(/[\\/]+$/, '') + sep + file.replace(/^\.[\\/]/, '')).split(/[\\/]/);
    const out = [];
    for (const p of parts) { if (p === '..' && out.length > 1) out.pop(); else if (p !== '.') out.push(p); }
    return out.join(sep);
  }

  function parseProblems(output, cwd, matcher = 'auto', limit = 500) {
    const names = matcher === 'auto' || !MATCHERS[matcher] ? AUTO : [matcher];
    const ctx = {};
    const seen = new Set();
    const res = [];
    for (const raw of stripAnsi(output).split(/\r?\n/)) {
      if (/^\s*[>$] /.test(raw)) continue; // command echoes ("> node x.js", npm's "> pkg@1 script")
      for (const n of names) {
        const p = MATCHERS[n](raw, ctx);
        if (!p) continue;
        if (!p.file || /node_modules/.test(p.file)) break;
        const item = { ...p, file: resolvePath(p.file, cwd) };
        const key = `${item.file}:${item.line}:${item.col}:${item.message}`;
        if (!seen.has(key)) { seen.add(key); res.push(item); }
        break;
      }
      if (res.length >= limit) break;
    }
    return res;
  }

  const api = { detectTasks, parseProblems, parseJsonc, stripAnsi, resolvePath, MATCHER_NAMES: Object.keys(MATCHERS) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NexoTasks = api;
})(typeof window !== 'undefined' ? window : globalThis);
