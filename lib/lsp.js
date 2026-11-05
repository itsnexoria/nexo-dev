'use strict';
// Language-server process manager. Main is a dumb pipe: it frames/unframes
// JSON-RPC (Content-Length) and forwards messages; the renderer owns the protocol.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { defaultServers, resolveStatus } = require('./lsp-servers');
// Defaults come from the server table (lib/lsp-servers.js). Overridable via the `lspServers`
// preference. Servers for languages Monaco already supports (TS/JS/JSON/CSS/HTML) are opt-in.
const DEFAULT_SERVERS = defaultServers();

function findExecutable(cmd, root, extraDirs = []) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  const dirs = [];
  if (root) dirs.push(path.join(root, 'node_modules', '.bin'));
  dirs.push(path.join(__dirname, '..', 'node_modules', '.bin'));
  dirs.push(...extraDirs);
  dirs.push(...(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean));
  for (const d of dirs) for (const e of exts) {
    const f = path.join(d, cmd + e);
    try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

// Pull Content-Length framed JSON messages out of a byte stream.
class MessageParser {
  constructor(onMessage) { this.buf = Buffer.alloc(0); this.onMessage = onMessage; }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headEnd = this.buf.indexOf('\r\n\r\n');
      if (headEnd === -1) return;
      const m = /Content-Length: *(\d+)/i.exec(this.buf.subarray(0, headEnd).toString('ascii'));
      if (!m) { this.buf = this.buf.subarray(headEnd + 4); continue; } // malformed header: skip
      const len = parseInt(m[1], 10);
      const start = headEnd + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString('utf-8');
      this.buf = this.buf.subarray(start + len);
      try { this.onMessage(JSON.parse(body)); } catch { /* ignore bad JSON */ }
    }
  }
}
const frame = (msg) => { const b = Buffer.from(JSON.stringify(msg), 'utf-8'); return Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`, 'ascii'), b]); };

class LspManager {
  constructor({ onMessage, onExit, getUserServers, extraBinDirs }) {
    this.extraBinDirs = extraBinDirs || (() => []);
    this.onMessage = onMessage; this.onExit = onExit; this.getUserServers = getUserServers || (() => ({}));
    this.procs = new Map(); this.seq = 0;
  }
  configFor(lang) {
    const user = this.getUserServers()[lang];
    if (user && user.command) return { command: user.command, args: user.args || [] };
    const d = DEFAULT_SERVERS[lang];
    if (!d || d.optIn) return null;
    return d;
  }
  // Per-language status rows for the Settings/palette UI.
  statusAll(root) {
    const userServers = this.getUserServers();
    const langs = [...new Set([...Object.keys(DEFAULT_SERVERS), ...Object.keys(userServers)])];
    const find = (c) => findExecutable(c, root, this.extraBinDirs());
    return langs.map((l) => resolveStatus(l, { userServers, find })).filter(Boolean);
  }
  start(lang, root) {
    const cfg = this.configFor(lang);
    if (!cfg) return { ok: false, error: `No language server configured for "${lang}".`, code: 'unconfigured' };
    const candidates = [cfg, ...(cfg.alt || [])];
    let exe = null, chosen = null;
    for (const c of candidates) { exe = findExecutable(c.command, root, this.extraBinDirs()); if (exe) { chosen = c; break; } }
    if (!exe) return { ok: false, error: `Language server "${cfg.command}" was not found. Install it or set its path in Settings.`, code: 'missing', command: cfg.command };
    const id = 'lsp-' + (++this.seq);
    let child;
    try {
      child = spawn(exe, chosen.args, { cwd: root, env: process.env, windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe) });
    } catch (err) { return { ok: false, error: err.message }; }
    const parser = new MessageParser((m) => this.onMessage(id, m));
    child.stdout.on('data', (d) => parser.push(d));
    child.stderr.on('data', () => {});
    child.on('error', (err) => { this.procs.delete(id); this.onExit(id, -1, err.message); });
    child.on('close', (code) => { this.procs.delete(id); this.onExit(id, code); });
    this.procs.set(id, child);
    return { ok: true, id, command: path.basename(exe), initializationOptions: this.initOptions(lang, root) };
  }
  // typescript-language-server needs a tsserver: prefer the project's own, else one bundled with the app (if present).
  initOptions(lang, root) {
    const d = DEFAULT_SERVERS[lang]; const u = this.getUserServers()[lang];
    if (d && d.initOptions && !(u && u.command)) return d.initOptions;
    if (lang !== 'typescript' && lang !== 'javascript') return undefined;
    const rel = path.join('node_modules', 'typescript', 'lib', 'tsserver.js');
    if (fs.existsSync(path.join(root, rel))) return undefined;
    // TypeScript 7 (native) has no tsserver.js, so the app ships a 5.x copy under an alias for this purpose.
    const bundled = path.join(__dirname, '..', 'node_modules', 'tsserver-host', 'lib', 'tsserver.js');
    return fs.existsSync(bundled) ? { tsserver: { path: bundled } } : undefined;
  }
  send(id, msg) { const c = this.procs.get(id); if (!c || !c.stdin.writable) return false; c.stdin.write(frame(msg)); return true; }
  stop(id) { const c = this.procs.get(id); if (c) { try { c.kill(); } catch { /* gone */ } this.procs.delete(id); } }
  stopAll() { for (const id of [...this.procs.keys()]) this.stop(id); }
}
module.exports = { LspManager, MessageParser, frame, findExecutable, DEFAULT_SERVERS };
