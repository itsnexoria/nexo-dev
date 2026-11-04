'use strict';
// MySQL / MariaDB driver (mysql2/promise). Read-only unless the connection profile enables writes.
const C = require('./common');

class MysqlImpl {
  async open(cfg, password) {
    const mysql = require('mysql2/promise');
    this.allowWrites = !!cfg.allowWrites;
    this.conn = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: password || undefined, database: cfg.database || undefined,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined, connectTimeout: 10000, rowsAsArray: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    });
    this.dbName = cfg.database || null;
    await this.setWrites(this.allowWrites);
    return {};
  }
  async setWrites(allow) {
    this.allowWrites = !!allow;
    await this.conn.query(`SET SESSION TRANSACTION ${allow ? 'READ WRITE' : 'READ ONLY'}`);
    try { await this.conn.query(`SET SESSION max_execution_time = ${C.STATEMENT_TIMEOUT_MS}`); } catch { /* MariaDB uses max_statement_time */
      try { await this.conn.query(`SET SESSION max_statement_time = ${C.STATEMENT_TIMEOUT_MS / 1000}`); } catch { /* unsupported */ }
    }
  }
  async listTables() {
    const [rows] = await this.conn.query(`SELECT table_schema, table_name, table_type FROM information_schema.tables
      WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys') ${this.dbName ? 'AND table_schema = DATABASE()' : ''} ORDER BY table_schema, table_name`);
    return rows.map(([schema, name, type]) => ({ schema, name, type: /VIEW/i.test(type) ? 'view' : 'table', count: null }));
  }
  async tableSchema(table) {
    const t = C.normTable(table);
    const [rows] = await this.conn.query(`SELECT column_name, data_type, is_nullable, column_default, column_key FROM information_schema.columns
      WHERE table_name = ? AND table_schema = COALESCE(?, DATABASE()) ORDER BY ordinal_position`, [t.name, t.schema]);
    return rows.map(([name, type, nullable, dflt, key]) => ({ name, type, notnull: nullable === 'NO', dflt, pk: key === 'PRI' }));
  }
  async browse(table, limit, offset) {
    const t = C.normTable(table);
    limit = C.clampLimit(limit); offset = C.clampOffset(offset);
    const pk = (await this.tableSchema(t)).filter((c) => c.pk).map((c) => c.name);
    const [rows, fields] = await this.conn.query(`SELECT * FROM ${C.quoteTable('mysql', t)} LIMIT ${limit} OFFSET ${offset}`);
    const columns = fields.map((f) => f.name);
    const rowKeys = pk.length ? rows.map((r) => Object.fromEntries(pk.map((c) => [c, r[columns.indexOf(c)]]))) : null;
    return { columns, rows: rows.map((r) => r.map(C.cell)), truncated: false, editable: !!rowKeys, rowKeys, pk };
  }
  async query(sql, { limit = C.MAX_ROWS } = {}) {
    if (!this.allowWrites && !C.isReadOnlySql(sql)) throw new Error('Read-only connection: only SELECT/WITH/EXPLAIN/SHOW statements are allowed. Enable "Allow writes" to run others.');
    const t0 = Date.now();
    const [res, fields] = await this.conn.query(sql);
    if (!Array.isArray(fields)) return { columns: [], rows: [], affected: res.affectedRows, timeMs: Date.now() - t0 };
    const columns = fields.map((f) => f.name);
    return { columns, rows: res.slice(0, limit).map((r) => r.map(C.cell)), truncated: res.length > limit, timeMs: Date.now() - t0 };
  }
  async updateCell({ table, set, where }) {
    if (!this.allowWrites) throw new Error('Connection is read-only. Enable "Allow writes" to edit cells.');
    const { sql, params } = C.buildUpdate('mysql', table, set, where);
    await this.conn.beginTransaction();
    try {
      const [r] = await this.conn.query(sql, params);
      if (r.affectedRows !== 1) throw new Error(`Update matched ${r.affectedRows} rows; nothing changed.`);
      await this.conn.commit();
    } catch (err) { await this.conn.rollback().catch(() => {}); throw err; }
    return { affected: 1 };
  }
  async close() { try { await this.conn.end(); } catch { /* gone */ } }
}
module.exports = { MysqlImpl };
