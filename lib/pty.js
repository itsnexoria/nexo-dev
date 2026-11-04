'use strict';
// Pseudo-terminal manager (node-pty via the prebuilt @lydell/node-pty fork — no compiler needed).
const fs = require('fs');

let ptyLib = null;
let loadError = null;
try { ptyLib = require('@lydell/node-pty'); } catch (err) { loadError = err; }

function defaultShell(customShell) {
  if (customShell) return customShell;
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
}

class PtyManager {
  constructor({ onData, onExit }) {
    this.onData = onData; this.onExit = onExit;
    this.sessions = new Map();
    this.seq = 0;
  }
  get available() { return !!ptyLib; }
  get error() { return loadError ? loadError.message : null; }

  spawn({ cwd, cols = 80, rows = 24, env, shell }) {
    if (!ptyLib) throw new Error('Terminal backend unavailable: ' + this.error);
    const dir = cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() ? cwd : require('os').homedir();
    const id = 'pty-' + (++this.seq) + '-' + Date.now().toString(36);
    const p = ptyLib.spawn(defaultShell(shell), [], {
      name: 'xterm-256color',
      cols: Math.max(2, cols | 0), rows: Math.max(1, rows | 0),
      cwd: dir,
      env: { ...(env || process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    p.onData((d) => this.onData(id, d));
    p.onExit(({ exitCode }) => { this.sessions.delete(id); this.onExit(id, exitCode); });
    this.sessions.set(id, p);
    return { id, pid: p.pid };
  }
  write(id, data) { const p = this.sessions.get(id); if (p) p.write(String(data)); return !!p; }
  resize(id, cols, rows) {
    const p = this.sessions.get(id);
    if (p && cols > 1 && rows > 0) { try { p.resize(cols | 0, rows | 0); } catch { /* already exited */ } }
  }
  kill(id) { const p = this.sessions.get(id); if (p) { try { p.kill(); } catch { /* gone */ } this.sessions.delete(id); } }
  killAll() { for (const id of [...this.sessions.keys()]) this.kill(id); }
}
module.exports = { PtyManager, defaultShell };
