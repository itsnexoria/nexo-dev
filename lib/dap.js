// Minimal Debug Adapter Protocol client (Content-Length framed JSON over a socket).
const net = require('net');
const { EventEmitter } = require('events');

class DapClient extends EventEmitter {
  constructor() {
    super();
    this.seq = 1;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.socket = null;
  }

  connect(port, host = '127.0.0.1', retries = 60) {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        const s = net.connect(port, host);
        s.once('connect', () => {
          this.socket = s;
          s.on('data', (d) => this._onData(d));
          s.on('close', () => this.emit('closed'));
          s.on('error', () => {});
          resolve();
        });
        s.once('error', () => {
          s.destroy();
          if (n <= 0) reject(new Error('Could not connect to debugger'));
          else setTimeout(() => attempt(n - 1), 250);
        });
      };
      attempt(retries);
    });
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.slice(0, headerEnd).toString());
      if (!m) { this.buf = Buffer.alloc(0); return; }
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.slice(start, start + len).toString('utf8');
      this.buf = this.buf.slice(start + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) p.resolve(msg.body || {});
      else p.reject(new Error(msg.message || 'DAP request failed'));
    } else if (msg.type === 'event') {
      this.emit('event', msg.event, msg.body || {});
    } else if (msg.type === 'request') {
      // reverse requests (runInTerminal / startDebugging) — acknowledge as unsupported
      this._write({ seq: this.seq++, type: 'response', request_seq: msg.seq, success: false, command: msg.command, message: 'unsupported' });
    }
  }

  _write(obj) {
    if (!this.socket || this.socket.destroyed) return;
    const body = JSON.stringify(obj);
    this.socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(command, args = {}, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const seq = this.seq++;
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`DAP timeout: ${command}`)); }, timeout);
      this.pending.set(seq, {
        resolve: (b) => { clearTimeout(timer); resolve(b); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._write({ seq, type: 'request', command, arguments: args });
    });
  }

  close() {
    for (const p of this.pending.values()) p.reject(new Error('closed'));
    this.pending.clear();
    if (this.socket) { try { this.socket.destroy(); } catch { /* gone */ } }
  }
}

module.exports = { DapClient };
