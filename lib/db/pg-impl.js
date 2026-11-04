'use strict';
// PostgreSQL driver (pg). Read-only unless the connection profile enables writes.
const C = require('./common');

class PgImpl {
  async open(cfg, password) {
    const { Client } = require('pg');
    this.allowWrites = !!cfg.allowWrites;
    this.client = new Client({
      host: cfg.host, port: cfg.port, user: cfg.user, password: password || undefined, database: cfg.database || undefined,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 10000,
      statement_timeout: C.STATEMENT_TIMEOUT_MS, query_timeout: C.STATEMENT_TIMEOUT_MS + 2000, application_name: 'Nexo Dev',
    });
    this.client.on('error', () => {});
    await this.client.connect();
    await this.setWrites(this.allowWrites);
    return {};
  }
  async setWrites(allow) {
    this.allowWrites = !!allow;
    await this.client.query(`SET default_transaction_read_only = ${allow ? 'off' : 'on'}`);
  }
  async listTables() {
    const r = await this.client.query(`SELECT table_schema AS s, table_name AS n, table_type AS t FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_type, table_name`);
    return r.rows.map((x) => ({ schema: x.s, name: x.n, type: x.t === 'VIEW' ? 'view' : 'table', count: null }));
  }
  async tableSchema(table) {
    const t = C.normTable(table);
    const r = await this.client.query(`
      SELECT c.column_name AS name, c.data_type AS type, c.is_nullable = 'NO' AS notnull, c.column_default AS dflt,
        EXISTS (SELECT 1 FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND k.column_name = c.column_name) AS pk
      FROM information_schema.columns c WHERE c.table_name = $1 AND c.table_schema = COALESCE($2, current_schema()) ORDER BY c.ordinal_position`, [t.name, t.schema]);
    return r.rows;
  }
  async browse(table, limit, offset) {
    const t = C.normTable(table);
    limit = C.clampLimit(limit); offset = C.clampOffset(offset);
    const cols = await this.tableSchema(t);
    const pk = cols.filter((c) => c.pk).map((c) => c.name);
    const res = await this.client.query({ text: `SELECT * FROM ${C.quoteTable('postgres', t)} LIMIT ${limit} OFFSET ${offset}`, rowMode: 'array' });
    const columns = res.fields.map((f) => f.name);
    const rows = res.rows.map((r) => r.map(C.cell));
    const rowKeys = pk.length ? res.rows.map((r) => Object.fromEntries(pk.map((c) => [c, r[columns.indexOf(c)]]))) : null;
    return { columns, rows, truncated: false, editable: !!rowKeys, rowKeys, pk };
  }
  async query(sql, { limit = C.MAX_ROWS } = {}) {
    if (!this.allowWrites && !C.isReadOnlySql(sql)) throw new Error('Read-only connection: only SELECT/WITH/EXPLAIN/SHOW statements are allowed. Enable "Allow writes" to run others.');
    const t0 = Date.now();
    const res = await this.client.query({ text: sql, rowMode: 'array' });
    const r = Array.isArray(res) ? res[res.length - 1] : res;
    const columns = (r.fields || []).map((f) => f.name);
    const all = r.rows || [];
    return { columns, rows: all.slice(0, limit).map((row) => row.map(C.cell)), truncated: all.length > limit, affected: r.rowCount, timeMs: Date.now() - t0 };
  }
  async updateCell({ table, set, where }) {
    if (!this.allowWrites) throw new Error('Connection is read-only. Enable "Allow writes" to edit cells.');
    const { sql, params } = C.buildUpdate('postgres', table, set, where);
    await this.client.query('BEGIN');
    try {
      const r = await this.client.query(sql, params);
      if (r.rowCount !== 1) throw new Error(`Update matched ${r.rowCount} rows; nothing changed.`);
      await this.client.query('COMMIT');
    } catch (err) { await this.client.query('ROLLBACK').catch(() => {}); throw err; }
    return { affected: 1 };
  }
  async close() { try { await this.client.end(); } catch { /* gone */ } }
}
module.exports = { PgImpl };
