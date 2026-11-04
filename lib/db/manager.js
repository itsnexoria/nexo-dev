'use strict';
// Connection manager: saved profiles (passwords encrypted via an injected `crypto` adapter), live connections by id.
const fs = require('fs');
const crypto = require('crypto');
const C = require('./common');
const { SqliteImpl } = require('./sqlite-impl');
const { PgImpl } = require('./pg-impl');
const { MysqlImpl } = require('./mysql-impl');

// store: { read(): object, write(obj) }; secrets: { encrypt(str)->string, decrypt(string)->str } (safeStorage in the app).
function createManager({ store, secrets }) {
  const live = new Map(); // connId -> { cfg, impl, file? }
  const data = () => { const d = store.read() || {}; return { connections: Array.isArray(d.connections) ? d.connections : [] }; };

  function list() { return data().connections.map(({ pw, ...rest }) => ({ ...rest, hasPassword: !!pw })); }
  function save(profile, password) {
    const v = C.validateConfig(profile);
    if (!v.ok) return v;
    const d = data();
    const cfg = v.config;
    cfg.id = cfg.id || crypto.randomBytes(8).toString('hex');
    const prev = d.connections.find((c) => c.id === cfg.id);
    let pw = prev ? prev.pw : undefined;
    if (typeof password === 'string') pw = password === '' ? undefined : secrets.encrypt(password);
    const next = { ...cfg, pw };
    d.connections = prev ? d.connections.map((c) => (c.id === cfg.id ? next : c)) : [...d.connections, next];
    store.write(d);
    return { ok: true, id: cfg.id };
  }
  function remove(id) { const d = data(); d.connections = d.connections.filter((c) => c.id !== id); store.write(d); return { ok: true }; }

  async function connectConfig(cfg, password) {
    let impl;
    if (cfg.driver === 'sqlite') { impl = new SqliteImpl(); await impl.open(cfg.file, cfg.allowWrites); }
    else if (cfg.driver === 'postgres') { impl = new PgImpl(); await impl.open(cfg, password); }
    else { impl = new MysqlImpl(); await impl.open(cfg, password); }
    const connId = crypto.randomBytes(8).toString('hex');
    live.set(connId, { cfg, impl });
    return connId;
  }
  async function connect(id) {
    const rec = data().connections.find((c) => c.id === id);
    if (!rec) throw new Error('Unknown connection.');
    const { pw, ...cfg } = rec;
    return connectConfig(cfg, pw ? secrets.decrypt(pw) : '');
  }
  const get = (connId) => { const c = live.get(connId); if (!c) throw new Error('Not connected.'); return c; };
  async function disconnect(connId) { const c = live.get(connId); if (c) { live.delete(connId); await c.impl.close(); } }
  async function closeAll() { for (const id of [...live.keys()]) await disconnect(id); }
  async function setWrites(connId, allow) { const c = get(connId); await c.impl.setWrites(!!allow); c.cfg.allowWrites = !!allow; }
  return { list, save, remove, connect, connectConfig, get, disconnect, closeAll, setWrites };
}
module.exports = { createManager };
