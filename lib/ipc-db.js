'use strict';
// IPC for the database manager (SQLite / PostgreSQL / MySQL). Channels are prefixed `dbc:`.
const fs = require('fs');
const path = require('path');
const C = require('./db/common');
const { createManager } = require('./db/manager');

function register({ ipcMain, dialog, getWindow, scope, storePath, secrets }) {
  const store = {
    read() { try { return JSON.parse(fs.readFileSync(storePath, 'utf-8')); } catch { return {}; } },
    write(obj) { fs.mkdirSync(path.dirname(storePath), { recursive: true }); fs.writeFileSync(storePath, JSON.stringify(obj, null, 2), { mode: 0o600 }); },
  };
  const mgr = createManager({ store, secrets });
  const wrap = (fn) => async (evt, ...args) => {
    try { return { ok: true, ...(await fn(...args)) }; } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  };
  const inScope = (file) => { if (scope && !scope.allows(file, { write: false })) throw new Error('That file is outside the open workspace. Use "Open database…" to pick it.'); };

  ipcMain.handle('dbc:list', wrap(async () => ({ connections: mgr.list() })));
  ipcMain.handle('dbc:save', wrap(async (profile, password) => {
    if (profile && profile.driver === 'sqlite' && typeof profile.file === 'string') inScope(profile.file);
    const r = mgr.save(profile, password);
    if (!r.ok) throw new Error(r.error);
    return { id: r.id };
  }));
  ipcMain.handle('dbc:delete', wrap(async (id) => mgr.remove(String(id))));
  ipcMain.handle('dbc:connect', wrap(async (id) => ({ connId: await mgr.connect(String(id)) })));
  ipcMain.handle('dbc:connect-file', wrap(async (file, allowWrites) => {
    inScope(file);
    const connId = await mgr.connectConfig({ driver: 'sqlite', name: path.basename(file), file, allowWrites: allowWrites === true });
    return { connId };
  }));
  ipcMain.handle('dbc:disconnect', wrap(async (connId) => { await mgr.disconnect(connId); return {}; }));
  ipcMain.handle('dbc:set-writes', wrap(async (connId, allow) => { await mgr.setWrites(connId, allow === true); return {}; }));
  ipcMain.handle('dbc:tables', wrap(async (connId) => ({ tables: await mgr.get(connId).impl.listTables() })));
  ipcMain.handle('dbc:schema', wrap(async (connId, table) => ({ columns: await mgr.get(connId).impl.tableSchema(table) })));
  ipcMain.handle('dbc:browse', wrap(async (connId, table, limit, offset) => await mgr.get(connId).impl.browse(table, limit, offset)));
  ipcMain.handle('dbc:query', wrap(async (connId, sql) => await mgr.get(connId).impl.query(String(sql))));
  ipcMain.handle('dbc:update', wrap(async (connId, edit) => {
    if (!edit || typeof edit !== 'object') throw new Error('Invalid edit.');
    return await mgr.get(connId).impl.updateCell({ table: edit.table, set: edit.set, where: edit.where });
  }));
  ipcMain.handle('dbc:export-csv', wrap(async (connId, src) => {
    const impl = mgr.get(connId).impl;
    let res;
    if (src && typeof src.sql === 'string') res = await impl.query(src.sql, { limit: C.EXPORT_MAX_ROWS });
    else if (src && src.table) res = await impl.query(`SELECT * FROM ${C.quoteTable(mgr.get(connId).cfg.driver, src.table)}`, { limit: C.EXPORT_MAX_ROWS });
    else throw new Error('Nothing to export.');
    const pick = await dialog.showSaveDialog(getWindow(), { defaultPath: 'export.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (pick.canceled || !pick.filePath) return { canceled: true };
    fs.writeFileSync(pick.filePath, toCsvBom(res.columns, res.rows));
    return { file: pick.filePath, rows: res.rows.length, truncated: !!res.truncated };
  }));
  ipcMain.handle('dbc:save-sqlite', wrap(async (connId) => {
    const c = mgr.get(connId);
    if (c.cfg.driver !== 'sqlite') throw new Error('Only SQLite files are saved this way.');
    inScope(c.cfg.file);
    if (!c.cfg.allowWrites) throw new Error('Connection is read-only.');
    const tmp = c.cfg.file + '.nexo-tmp';
    fs.writeFileSync(tmp, Buffer.from(c.impl.export()));
    fs.renameSync(tmp, c.cfg.file);
    c.impl.markClean();
    return {};
  }));
  const toCsvBom = (cols, rows) => '﻿' + C.toCsv(cols, rows);
  return { shutdown: () => mgr.closeAll(), manager: mgr };
}
module.exports = { register };
