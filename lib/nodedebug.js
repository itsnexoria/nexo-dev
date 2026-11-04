'use strict';
// Node.js / TypeScript debug session over the Chrome DevTools (V8 inspector) Protocol.
// Spawns `node --inspect-brk=0 <file>`, discovers the ws:// URL from stderr and drives it.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const SCRIPT_RE = /\.(?:[cm]?js)$/i;
const TS_RE = /\.(?:[cm]?ts|tsx)$/i;
const isNodeDebuggable = (f) => SCRIPT_RE.test(f) || TS_RE.test(f);

function findOnPath(name, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD').split(';') : [''];
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const p = path.join(dir, name + (process.platform === 'win32' ? e.toLowerCase() : e));
      try { if (fs.statSync(p).isFile() && (process.platform === 'win32' || (fs.statSync(p).mode & 0o111))) return p; } catch { /* next */ }
    }
  }
  return null;
}

// System node if present, otherwise this (Electron) binary running as plain node.
function resolveNode(env = process.env) {
  const sys = findOnPath('node', env);
  if (sys) return { bin: sys, env: {} };
  return { bin: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

// TypeScript runner: tsx or ts-node from the project's node_modules. Returns node argv prefix.
function resolveTsRunner(cwd) {
  const nm = path.join(cwd, 'node_modules');
  const tsx = path.join(nm, 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(tsx)) return { name: 'tsx', args: [tsx], flagsAfter: true };
  const tsnode = path.join(nm, 'ts-node', 'dist', 'bin.js');
  if (fs.existsSync(tsnode)) return { name: 'ts-node', args: [tsnode], flagsAfter: false };
  return null;
}

// node argv for debugging `file`; throws {code:'no-ts-runner'} for TS without tsx/ts-node.
function buildArgv(file, cwd) {
  if (TS_RE.test(file)) {
    const r = resolveTsRunner(cwd);
    if (!r) { const e = new Error('To debug TypeScript, install tsx or ts-node in this project (npm i -D tsx).'); e.code = 'no-ts-runner'; throw e; }
    return r.flagsAfter ? [...r.args, '--inspect-brk=0', file] : ['--inspect-brk=0', ...r.args, file];
  }
  if (SCRIPT_RE.test(file)) return ['--inspect-brk=0', file];
  throw new Error('Not a JavaScript or TypeScript file.');
}

// Render a CDP RemoteObject as a short string.
function formatRemote(o) {
  if (!o) return 'undefined';
  if (o.type === 'string') return JSON.stringify(o.value);
  if (o.type === 'undefined') return 'undefined';
  if (o.unserializableValue) return o.unserializableValue;
  if (o.type === 'object' || o.type === 'function' || o.type === 'symbol') {
    if (o.subtype === 'null') return 'null';
    return o.description || o.className || o.type;
  }
  return String(o.value);
}

class NodeDebugSession extends EventEmitter {
  // opts: { file, cwd, env, breakpoints: { [file]: [line,...] }, onEvent(name, payload), nodeBin? }
  constructor(opts) {
    super();
    this.opts = opts;
    this.proc = null;
    this.ws = null;
    this.id = 1;
    this.pending = new Map();
    this.scripts = new Map(); // scriptId -> url
    this.bpIds = new Map(); // file -> [breakpointId]
    this.frames = [];
    this.startBreakHandled = false;
    this.ended = false;
    this.paused = false;
  }

  emitUi(name, payload) { try { this.opts.onEvent(name, payload); } catch { /* ui gone */ } }

  _send(method, params = {}, timeout = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { reject(new Error('Debugger is not connected.')); return; }
      const id = this.id++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeout);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP error')); else p.resolve(msg.result || {});
    } else if (msg.method) this._onEvent(msg.method, msg.params || {});
  }

  async start() {
    const { file, breakpoints } = this.opts;
    const cwd = this.opts.cwd || path.dirname(file);
    const node = this.opts.nodeBin ? { bin: this.opts.nodeBin, env: {} } : resolveNode(this.opts.env || process.env);
    const argv = buildArgv(file, cwd);

    const env = { ...(this.opts.env || process.env), ...node.env };
    this.proc = spawn(node.bin, argv, { cwd, env, windowsHide: true, detached: process.platform !== 'win32' });

    let errBuf = '';
    let wsUrl = null;
    let urlWaiter = null;
    const gotUrl = new Promise((resolve, reject) => { urlWaiter = { resolve, reject }; });
    this.proc.stdout.on('data', (d) => this.emitUi('output', { category: 'stdout', output: d.toString() }));
    this.proc.stderr.on('data', (d) => {
      let text = d.toString();
      if (!wsUrl) {
        errBuf += text;
        const m = /Debugger listening on (ws:\/\/\S+)/.exec(errBuf);
        if (m) { wsUrl = m[1]; urlWaiter.resolve(wsUrl); }
      }
      if (/Waiting for the debugger to disconnect/.test(text) && this.ws) { try { this.ws.close(); } catch { /* gone */ } }
      text = text.split(/(?<=\n)/).filter((l) => !/Debugger listening on|For help, see: https:\/\/nodejs\.org\/en\/docs\/inspector|Debugger attached\.|Waiting for the debugger to disconnect/.test(l)).join('');
      if (text) this.emitUi('output', { category: 'stderr', output: text });
    });
    this.proc.on('close', (code) => { urlWaiter.reject(new Error(`Process exited before debugger attached (code ${code}).`)); this._finish(code == null ? 0 : code); });
    this.proc.on('error', (e) => { urlWaiter.reject(e); this.emitUi('output', { category: 'stderr', output: e.message + '\n' }); this._finish(-1); });
    gotUrl.catch(() => {});

    const timer = setTimeout(() => urlWaiter.reject(new Error('Timed out waiting for the Node inspector.')), 20000);
    try { await gotUrl; } finally { clearTimeout(timer); }

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
      this.ws = ws;
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.on('message', (m) => this._onMessage(m));
      ws.on('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('Debugger disconnected.'));
        this.pending.clear();
        setTimeout(() => this._finish(0), 1500).unref();
      });
    });
    this.ws.on('error', () => {});

    await this._send('Runtime.enable');
    await this._send('Debugger.enable');
    await this._send('Debugger.setBlackboxPatterns', { patterns: ['^node:'] }).catch(() => {});
    await this._send('Debugger.setPauseOnExceptions', { state: 'uncaught' }).catch(() => {});
    await this._send('Debugger.setPauseOnExceptions', { state: 'uncaught' }).catch(() => {});
    for (const [f, lines] of Object.entries(breakpoints || {})) await this.setBreakpoints(f, lines);
    await this._send('Runtime.runIfWaitingForDebugger');
  }

  _finish(code) {
    if (this.ended) return;
    this.ended = true;
    if (this.ws) { try { this.ws.terminate(); } catch { /* gone */ } }
    this.kill();
    this.emitUi('terminated', { code });
  }

  kill() {
    const p = this.proc;
    if (!p || p.exitCode !== null || p.signalCode) return;
    const sig = (s) => { try { if (process.platform !== 'win32') process.kill(-p.pid, s); else p.kill(s); } catch { try { p.kill(s); } catch { /* gone */ } } };
    sig('SIGTERM');
    setTimeout(() => { if (p.exitCode === null && !p.signalCode) sig('SIGKILL'); }, 1500).unref();
  }

  _urlToPath(url) {
    if (!url || !url.startsWith('file:')) return null;
    try { return fileURLToPath(url); } catch { return null; }
  }

  async _onEvent(method, p) {
    if (method === 'Debugger.scriptParsed') this.scripts.set(p.scriptId, p.url);
    else if (method === 'Debugger.resumed') { this.paused = false; this.emitUi('continued', {}); }
    else if (method === 'Debugger.paused') await this._onPaused(p);
    else if (method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      if (text) this.emitUi('output', { category: 'stderr', output: `Uncaught ${text}\n` });
    } else if (method === 'Runtime.consoleAPICalled') { /* stdout already forwarded from the process */ }
  }

  async _onPaused(p) {
    if (!this.startBreakHandled && /Break on start/i.test(p.reason || '')) {
      this.startBreakHandled = true;
      this._send('Debugger.resume').catch(() => {});
      return;
    }
    const frames = [];
    for (const cf of p.callFrames || []) {
      const url = cf.url || this.scripts.get(cf.location.scriptId) || '';
      const file = this._urlToPath(url);
      if (!file) continue; // skip node internals
      frames.push({ id: cf.callFrameId, name: cf.functionName || '(anonymous)', file, line: cf.location.lineNumber + 1, _cf: cf });
    }
    if (!frames.length) { this._send('Debugger.resume').catch(() => {}); return; }
    this.frames = frames;
    this.paused = true;
    let variables = [];
    try { variables = await this._frameVars(frames[0]); } catch { /* keep empty */ }
    this.emitUi('stopped', {
      reason: /exception|promiseRejection/i.test(p.reason) ? 'exception' : (p.hitBreakpoints && p.hitBreakpoints.length ? 'breakpoint' : 'step'),
      frames: frames.map(({ _cf, ...f }) => f),
      variables,
    });
  }

  _fmt(o) { return formatRemote(o); }

  async _frameVars(frame) {
    const cf = frame._cf || (this.frames.find((f) => f.id === frame.id) || {})._cf;
    if (!cf) return [];
    const MODULE_NOISE = new Set(['exports', 'require', 'module', '__filename', '__dirname']);
    const labels = { local: 'Local', closure: 'Closure', block: 'Block', catch: 'Catch', module: 'Module', script: 'Script', with: 'With', eval: 'Eval', wasm: 'Wasm' };
    const out = [];
    for (const sc of cf.scopeChain || []) {
      if (sc.type === 'global' || !sc.object || !sc.object.objectId) continue;
      const r = await this._send('Runtime.getProperties', { objectId: sc.object.objectId, ownProperties: true });
      for (const prop of r.result || []) {
        if (prop.name === '__proto__') continue;
        if (sc.type === 'local' && !cf.functionName && MODULE_NOISE.has(prop.name)) continue;
        const v = prop.value;
        if (!v && prop.get) { out.push({ scope: labels[sc.type] || sc.type, name: prop.name, value: '(getter)', type: '' }); continue; }
        out.push({ scope: labels[sc.type] || sc.type, name: prop.name, value: this._fmt(v), type: v ? (v.subtype || v.className || v.type) : '' });
      }
    }
    return out;
  }

  async frameVariables(frameId) {
    const f = this.frames.find((x) => x.id === frameId);
    return f ? this._frameVars(f) : [];
  }

  async setBreakpoints(file, lines) {
    if (this.ended) return;
    for (const id of this.bpIds.get(file) || []) await this._send('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => {});
    const ids = [];
    const url = pathToFileURL(file).href;
    for (const line of lines || []) {
      try {
        const r = await this._send('Debugger.setBreakpointByUrl', { lineNumber: line - 1, url });
        if (r.breakpointId) ids.push(r.breakpointId);
      } catch { /* ignore a single failure */ }
    }
    this.bpIds.set(file, ids);
  }

  async control(cmd) {
    if (this.ended) return;
    const map = { continue: 'Debugger.resume', next: 'Debugger.stepOver', stepIn: 'Debugger.stepInto', stepOut: 'Debugger.stepOut', pause: 'Debugger.pause' };
    if (!map[cmd]) return;
    await this._send(map[cmd]);
  }

  async evaluate(expression, frameId) {
    const r = frameId
      ? await this._send('Debugger.evaluateOnCallFrame', { callFrameId: frameId, expression, generatePreview: true })
      : await this._send('Runtime.evaluate', { expression, generatePreview: true, replMode: true });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      throw new Error((ex && (ex.description || ex.value)) || r.exceptionDetails.text || 'Evaluation failed');
    }
    return this._fmt(r.result);
  }

  write(text) { if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) this.proc.stdin.write(text); }

  stop() {
    if (this.ended) return;
    this.kill();
    // process 'close' will emit terminated; make sure it does even if the pipe lingers
    setTimeout(() => this._finish(0), 2000).unref();
  }
}

module.exports = { NodeDebugSession, resolveNode, resolveTsRunner, isNodeDebuggable, buildArgv, formatRemote, findOnPath };
