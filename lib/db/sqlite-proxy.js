'use strict';
// Same async interface as SqliteImpl, but executes in a worker thread with a per-call timeout.
const path = require('path');
const { Worker } = require('worker_threads');
const C = require('./common');

class SqliteProxy {
  constructor() { this.worker = null; this.seq = 0; this.pending = new Map(); this.dirty = false; this.dead = null; this.allowWrites = false; }
  _start() {
    const w = new Worker(path.join(__dirname, 'sqlite-worker.js'));
    w.on('message', (m) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
    });
    const fail = (err) => { this._failAll(err); };
    w.on('error', fail);
    w.on('exit', () => fail(new Error('Database worker stopped.')));
    this.worker = w;
  }
  _failAll(err) {
    this.dead = this.dead || err;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
  _call(method, args = [], timeout = C.STATEMENT_TIMEOUT_MS) {
    if (this.dead) return Promise.reject(this.dead);
    if (!this.worker) this._start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(`Query timed out after ${Math.round(timeout / 1000)}s; the connection was closed${this.dirty ? ' (unsaved edits were lost)' : ''}. Reconnect to continue.`);
        this.dead = err;
        this.worker.terminate().catch(() => {});
        this._failAll(err);
        reject(err);
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, method, args });
    });
  }
  async open(file, allowWrites) { this.allowWrites = !!allowWrites; return this._call('open', [file, allowWrites], 60000); }
  async setWrites(allow) { this.allowWrites = !!allow; return this._call('setWrites', [allow]); }
  listTables() { return this._call('listTables'); }
  tableSchema(t) { return this._call('tableSchema', [t]); }
  browse(t, l, o) { return this._call('browse', [t, l, o]); }
  async query(sql, opts) { const r = await this._call('query', [sql, opts]); if (this.allowWrites && !C.isReadOnlySql(sql)) this.dirty = true; return r; }
  async updateCell(e) { const r = await this._call('updateCell', [e]); this.dirty = true; return r; }
  export() { return this._call('export', [], 60000); }
  async markClean() { this.dirty = false; return this._call('markClean'); }
  async close() { try { if (this.worker) { await this._call('close', [], 3000).catch(() => {}); await this.worker.terminate(); } } catch { /* gone */ } this.worker = null; this.dead = this.dead || new Error('Closed.'); }
}
module.exports = { SqliteProxy };
