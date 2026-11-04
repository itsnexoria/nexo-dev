'use strict';
// IPC handlers for Live Server, HTTP client and the SQLite viewer.
const path = require('path');
const fs = require('fs');
const { startLiveServer } = require('./liveserver');
const { sendRequest } = require('./httpclient');
const sqlite = require('./sqlite');
const { HttpStore, substituteRequest, unresolved } = require('./http-store');
const { parseCurl, toCurl } = require('./curl-parse');

function register({ ipcMain, dialog, shell, getWindow, scope, httpStorePath }) {
  const httpStore = httpStorePath ? new HttpStore(httpStorePath) : null;
  let live = null; // { root, port, url, close }

  ipcMain.handle('live:start', async (evt, root, port) => {
    if (typeof root !== 'string' || !fs.existsSync(root)) return { ok: false, error: 'Open a folder first.' };
    if (live) await live.close();
    live = null;
    try {
      const p = Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
      const s = await startLiveServer({ root, port: p });
      live = { ...s, root };
      return { ok: true, url: s.url, port: s.port, root };
    } catch (err) {
      return { ok: false, error: err.code === 'EADDRINUSE' ? 'That port is already in use.' : err.message };
    }
  });
  ipcMain.handle('live:stop', async () => { if (live) await live.close(); live = null; return { ok: true }; });
  ipcMain.handle('live:status', () => (live ? { running: true, url: live.url, port: live.port, root: live.root } : { running: false }));

  ipcMain.handle('http:send', (evt, req, vars) => {
    req = req || {};
    const missing = unresolved([req.url, req.body, ...Object.values(req.headers || {})].join('\n'), vars);
    return sendRequest(substituteRequest(req, vars || {})).then((r) => ({ ...r, unresolved: missing }));
  });
  ipcMain.handle('http:store-load', () => (httpStore ? { ok: true, doc: httpStore.load() } : { ok: false, error: 'Store unavailable.' }));
  ipcMain.handle('http:store-save', (evt, doc) => { try { return { ok: true, doc: httpStore.save(doc) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('http:parse-curl', (evt, text) => { try { return { ok: true, request: parseCurl(String(text)) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('http:to-curl', (evt, req, vars) => { try { return { ok: true, curl: toCurl(substituteRequest(req || {}, vars || {})) }; } catch (e) { return { ok: false, error: e.message }; } });

  const wrap = (fn) => async (evt, ...args) => {
    try { return { ok: true, ...(await fn(...args)) }; } catch (err) { return { ok: false, error: err.message }; }
  };
  ipcMain.handle('db:pick', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      properties: ['openFile'], filters: [{ name: 'SQLite', extensions: ['sqlite', 'sqlite3', 'db', 'db3'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (res.canceled) return { ok: false };
    if (scope) scope.addFile(res.filePaths[0]);
    return { ok: true, file: res.filePaths[0] };
  });
  ipcMain.handle('db:tables', wrap(async (file) => ({ tables: await sqlite.listTables(file) })));
  ipcMain.handle('db:schema', wrap(async (file, table) => ({ columns: await sqlite.tableSchema(file, table) })));
  ipcMain.handle('db:browse', wrap(async (file, table, limit, offset) => await sqlite.browseTable(file, table, limit, offset)));
  ipcMain.handle('db:query', wrap(async (file, sql) => await sqlite.runQuery(file, String(sql))));

  return { shutdown: async () => { if (live) await live.close(); sqlite.closeAll(); } };
}
module.exports = { register };
