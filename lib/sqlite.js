'use strict';
// Read-only SQLite viewer on top of sql.js (WASM — no native build needed).
// The file is loaded into memory, so nothing a query does can touch the file on disk.
const fs = require('fs');
const path = require('path');

let SQLPromise = null;
function getSQL() {
  if (!SQLPromise) {
    const initSqlJs = require('sql.js');
    const wasm = fs.readFileSync(path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm'));
    SQLPromise = initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  }
  return SQLPromise;
}
const MAX_FILE = 200 * 1024 * 1024;
const MAX_ROWS = 1000;
const dbs = new Map(); // file -> Database

async function openDb(file) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_FILE) throw new Error('Database is larger than 200 MB.');
  const SQL = await getSQL();
  if (dbs.has(file)) { try { dbs.get(file).close(); } catch { /* ignore */ } }
  const db = new SQL.Database(fs.readFileSync(file));
  dbs.set(file, db);
  return db;
}

function rowsOf(res) {
  if (!res.length) return { columns: [], rows: [] };
  const r = res[0];
  return { columns: r.columns, rows: r.values.slice(0, MAX_ROWS).map((row) => row.map(cell)), truncated: r.values.length > MAX_ROWS };
}
function cell(v) { return v instanceof Uint8Array ? `<blob ${v.length} bytes>` : v; }
const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';

async function listTables(file) {
  const db = await openDb(file);
  const res = db.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
  const items = res.length ? res[0].values : [];
  return items.map(([name, type]) => {
    let count = null;
    try { count = db.exec(`SELECT COUNT(*) FROM ${q(name)}`)[0].values[0][0]; } catch { /* view may fail */ }
    return { name, type, count };
  });
}
async function tableSchema(file, table) {
  const db = dbs.get(file) || await openDb(file);
  const info = db.exec(`PRAGMA table_info(${q(table)})`);
  return info.length ? info[0].values.map(([cid, name, type, notnull, dflt, pk]) => ({ name, type, notnull: !!notnull, dflt, pk: !!pk })) : [];
}
async function browseTable(file, table, limit = 100, offset = 0) {
  const db = dbs.get(file) || await openDb(file);
  limit = Math.max(1, Math.min(MAX_ROWS, parseInt(limit, 10) || 100));
  offset = Math.max(0, parseInt(offset, 10) || 0);
  return rowsOf(db.exec(`SELECT * FROM ${q(table)} LIMIT ${limit} OFFSET ${offset}`));
}
async function runQuery(file, sql) {
  const db = dbs.get(file) || await openDb(file);
  const t0 = Date.now();
  const out = rowsOf(db.exec(sql));
  return { ...out, timeMs: Date.now() - t0 };
}
function closeAll() { for (const d of dbs.values()) { try { d.close(); } catch { /* ignore */ } } dbs.clear(); }

module.exports = { listTables, tableSchema, browseTable, runQuery, closeAll };
