// Python debug session built on debugpy + the DAP client.
const { spawn } = require('child_process');
const net = require('net');
const { DapClient } = require('./dap');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

class PyDebugSession {
  // opts: { python, file, cwd, env, breakpoints: { [file]: [line,...] }, onEvent(name, payload) }
  constructor(opts) {
    this.opts = opts;
    this.dap = new DapClient();
    this.proc = null;
    this.threadId = null;
    this.ended = false;
  }

  emit(name, payload) { try { this.opts.onEvent(name, payload); } catch { /* ui gone */ } }

  async start() {
    const { python, file, cwd, env, breakpoints } = this.opts;
    const port = await freePort();
    this.proc = spawn(python, ['-Xfrozen_modules=off', '-m', 'debugpy', '--listen', `127.0.0.1:${port}`, '--wait-for-client', file], { cwd, env, windowsHide: true });
    let stderrBuf = '';
    this.proc.stdout.on('data', (d) => this.emit('output', { category: 'stdout', output: d.toString() }));
    this.proc.stderr.on('data', (d) => { stderrBuf += d.toString(); this.emit('output', { category: 'stderr', output: d.toString() }); });
    this.proc.on('close', (code) => this._finish(code));
    this.proc.on('error', (e) => { this.emit('output', { category: 'stderr', output: e.message + '\n' }); this._finish(-1); });

    try { await this.dap.connect(port); }
    catch (e) {
      if (/No module named debugpy/.test(stderrBuf)) throw new Error('no-debugpy');
      throw e;
    }
    this.dap.on('event', (ev, body) => this._onEvent(ev, body));
    this.dap.on('closed', () => this._finish(0));

    await this.dap.request('initialize', { clientID: 'nexo', adapterID: 'python', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
    // debugpy answers `attach` only after configurationDone, so don't await it
    const attached = this.dap.request('attach', { justMyCode: true }, 60000).catch(() => {});
    for (const [source, lines] of Object.entries(breakpoints || {})) {
      await this.dap.request('setBreakpoints', { source: { path: source }, breakpoints: lines.map((line) => ({ line })) });
    }
    await this.dap.request('setExceptionBreakpoints', { filters: ['uncaught'] }).catch(() => {});
    await this.dap.request('configurationDone');
    await attached;
  }

  _finish(code) {
    if (this.ended) return;
    this.ended = true;
    this.dap.close();
    if (this.proc) { try { this.proc.kill(); } catch { /* gone */ } }
    this.emit('terminated', { code });
  }

  async _onEvent(ev, body) {
    if (ev === 'stopped') {
      this.threadId = body.threadId || this.threadId || 1;
      try {
        const st = await this.dap.request('stackTrace', { threadId: this.threadId, levels: 30 });
        const frames = st.stackFrames.map((f) => ({ id: f.id, name: f.name, file: f.source && f.source.path, line: f.line }));
        const variables = frames[0] ? await this.scopes(frames[0].id) : [];
        this.emit('stopped', { reason: body.reason, frames, variables });
      } catch (e) { this.emit('stopped', { reason: body.reason, frames: [], variables: [], error: e.message }); }
    } else if (ev === 'continued') this.emit('continued', {});
    else if (ev === 'output') { if (body.category !== 'telemetry') this.emit('output', { category: body.category || 'console', output: body.output }); }
    else if (ev === 'thread' && body.reason === 'started' && !this.threadId) this.threadId = body.threadId;
    else if (ev === 'terminated' || ev === 'exited') this._finish(body.exitCode || 0);
  }

  async scopes(frameId) {
    const sc = await this.dap.request('scopes', { frameId });
    const out = [];
    for (const scope of sc.scopes) {
      if (/global/i.test(scope.name)) continue;
      const vars = await this.dap.request('variables', { variablesReference: scope.variablesReference });
      for (const v of vars.variables) {
        if (/^(special variables|function variables|class variables)$/.test(v.name)) continue;
        out.push({ scope: scope.name, name: v.name, value: v.value, type: v.type || '' });
      }
    }
    return out;
  }

  async frameVariables(frameId) { return this.scopes(frameId); }

  async setBreakpoints(file, lines) {
    if (this.ended) return;
    await this.dap.request('setBreakpoints', { source: { path: file }, breakpoints: lines.map((line) => ({ line })) });
  }

  async control(cmd) {
    if (this.ended) return;
    const map = { continue: 'continue', next: 'next', stepIn: 'stepIn', stepOut: 'stepOut', pause: 'pause' };
    if (!map[cmd]) return;
    await this.dap.request(map[cmd], { threadId: this.threadId || 1 });
  }

  write(text) { if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) this.proc.stdin.write(text); }

  async evaluate(expression, frameId) {
    const r = await this.dap.request('evaluate', { expression, frameId, context: 'repl' });
    return r.result;
  }

  stop() {
    if (this.ended) return;
    this.dap.request('disconnect', { terminateDebuggee: true }, 2000).catch(() => {}).finally(() => this._finish(0));
  }
}

module.exports = { PyDebugSession };
