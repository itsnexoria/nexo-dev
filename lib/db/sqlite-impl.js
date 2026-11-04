'use strict';
// SQLite on sql.js (WASM). The file is loaded into memory; edits stay in memory until export() is
// written out by the caller. Runs inside a worker thread (see sqlite.js) so a runaway query can be killed.
const fs = require('fs');
const path = require('path');
const C = require('./common');

const MAX_FILE = 200 * 1024 * 1024;
let SQLPromise = null;
function getSQL() {
  if (!SQLPromise) {
    const initSqlJs = require('sql.js');
    const wasm = fs.readFileSync(path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm'));
    SQLPromise = initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  }
  return SQLPromise;
}

class SqliteImpl {
  async open(file, allowWrites) {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE) throw new Error('Database is larger than 200 MB.');
    const SQL = await getSQL();
    this.db = new SQL.Database(fs.readFileSync(file));
    this.dirty = false;
    this.setWrites(allowWrites);
    return {};
  }
  setWrites(allow) { this.allowWrites = !!allow; this.db.run(`PRAGMA query_only = ${allow ? 'OFF' : 'ON'}`); }
  rows(res, limit) {
    if (!res.length) return { columns: [], rows: [] };
    const r = res[0];
    return { columns: r.columns, rows: r.values.slice(0, limit).map((row) => row.map(C.cell)), truncated: r.values.length > limit };
  }
  listTables() {
    const res = this.db.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
    return (res.length ? res[0].values : []).map(([name, type]) => {
      let count = null;
      try { count = this.db.exec(`SELECT COUNT(*) FROM ${C.quoteIdent('sqlite', name)}`)[0].values[0][0]; } catch { /* view may fail */ }
      return { name, type, count };
    });
  }
  tableSchema(table) {
    const t = C.normTable(table);
    const info = this.db.exec(`PRAGMA table_info(${C.quoteIdent('sqlite', t.name)})`);
    return info.length ? info[0].values.map(([, name, type, notnull, dflt, pk]) => ({ name, type, notnull: !!notnull, dflt, pk: !!pk })) : [];
  }
  browse(table, limit, offset) {
    const t = C.normTable(table);
    limit = C.clampLimit(limit); offset = C.clampOffset(offset);
    const cols = this.tableSchema(t);
    const pk = cols.filter((c) => c.pk).map((c) => c.name);
    const isView = this.db.exec(`SELECT type FROM sqlite_master WHERE name = ${this.lit(t.name)}`)[0]?.values[0][0] === 'view';
    const useRowid = !pk.length && !isView;
    const q = C.quoteIdent('sqlite', t.name);
    const res = this.db.exec(`SELECT ${useRowid ? 'rowid AS "__nexo_rowid", ' : ''}* FROM ${q} LIMIT ${limit} OFFSET ${offset}`);
    const out = this.rows(res, limit);
    let rowKeys = null;
    if (out.columns.length) {
      if (useRowid) {
        out.columns = out.columns.slice(1);
        rowKeys = out.rows.map((r) => ({ __rowid__: r.shift() }));
      } else if (pk.length) {
        rowKeys = out.rows.map((r) => Object.fromEntries(pk.map((c) => [c, r[out.columns.indexOf(c)]])));
      }
    }
    return { ...out, editable: !!rowKeys, rowKeys, pk: useRowid ? ['rowid'] : pk };
  }
  lit(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
  query(sql, { limit = C.MAX_ROWS } = {}) {
    if (!this.allowWrites && !C.isReadOnlySql(sql)) throw new Error('Read-only connection: only SELECT/WITH/EXPLAIN/PRAGMA(read) statements are allowed. Enable "Allow writes" to run others.');
    const t0 = Date.now();
    const before = this.db.getRowsModified();
    const out = this.rows(this.db.exec(sql), limit);
    if (this.allowWrites && !C.isReadOnlySql(sql)) this.dirty = true;
    return { ...out, timeMs: Date.now() - t0, before };
  }
  updateCell({ table, set, where }) {
    if (!this.allowWrites) throw new Error('Connection is read-only. Enable "Allow writes" to edit cells.');
    const { sql, params } = C.buildUpdate('sqlite', table, set, where);
    this.db.run('SAVEPOINT nexo_edit');
    try {
      this.db.run(sql, params);
      const n = this.db.getRowsModified();
      if (n !== 1) { this.db.run('ROLLBACK TO nexo_edit'); this.db.run('RELEASE nexo_edit'); throw new Error(`Update matched ${n} rows; nothing changed.`); }
      this.db.run('RELEASE nexo_edit');
    } catch (err) {
      try { this.db.run('ROLLBACK TO nexo_edit'); this.db.run('RELEASE nexo_edit'); } catch { /* already rolled back */ }
      throw err;
    }
    this.dirty = true;
    return { affected: 1 };
  }
  export() { this.db.run('PRAGMA query_only = OFF'); const b = this.db.export(); this.setWrites(this.allowWrites); return b; }
  markClean() { this.dirty = false; }
  close() { try { this.db.close(); } catch { /* ignore */ } }
}
module.exports = { SqliteImpl };
