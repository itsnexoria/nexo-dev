'use strict';
// Pure helpers shared by the database drivers (no I/O, unit-tested in test/db.test.js).
const DRIVERS = ['sqlite', 'postgres', 'mysql'];
const DEFAULT_PORT = { postgres: 5432, mysql: 3306 };
const MAX_ROWS = 1000;
const EXPORT_MAX_ROWS = 100000;
const STATEMENT_TIMEOUT_MS = 15000;

function quoteIdent(dialect, name) {
  if (typeof name !== 'string' || !name || name.length > 256 || name.includes('\0')) throw new Error('Invalid identifier.');
  if (dialect === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
  if (dialect === 'sqlite' || dialect === 'postgres') return '"' + name.replace(/"/g, '""') + '"';
  throw new Error('Unknown dialect.');
}
// table may be a string or { schema, name }.
function normTable(t) {
  if (typeof t === 'string') return { schema: null, name: t };
  if (t && typeof t === 'object' && typeof t.name === 'string') return { schema: typeof t.schema === 'string' && t.schema ? t.schema : null, name: t.name };
  throw new Error('Invalid table.');
}
function quoteTable(dialect, t) {
  const { schema, name } = normTable(t);
  return (schema ? quoteIdent(dialect, schema) + '.' : '') + quoteIdent(dialect, name);
}
function clampLimit(limit, def = 100, max = MAX_ROWS) {
  const n = parseInt(limit, 10);
  return Math.max(1, Math.min(max, Number.isFinite(n) ? n : def));
}
function clampOffset(offset) { return Math.max(0, parseInt(offset, 10) || 0); }

// Display-safe cell value.
function cell(v) {
  if (v == null) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
  if (v instanceof Uint8Array) return `<blob ${v.length} bytes>`;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return v;
}

// RFC 4180: CRLF line ends, quote fields containing comma, quote, CR or LF; "" escapes a quote.
function csvField(v) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(cell(v));
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(columns, rows) {
  const lines = [columns.map(csvField).join(',')];
  for (const r of rows) lines.push(r.map(csvField).join(','));
  return lines.join('\r\n') + '\r\n';
}

// Parameterised single-row UPDATE. where: { col: value } ; the special key '__rowid__' maps to SQLite's rowid.
function buildUpdate(dialect, table, set, where) {
  const sk = Object.keys(set || {}), wk = Object.keys(where || {});
  if (!sk.length) throw new Error('Nothing to update.');
  if (!wk.length) throw new Error('This row has no primary key, so it cannot be edited safely.');
  const params = [];
  const ph = (v) => { params.push(v); return dialect === 'postgres' ? '$' + params.length : '?'; };
  const setSql = sk.map((c) => `${quoteIdent(dialect, c)} = ${ph(set[c])}`).join(', ');
  const whereSql = wk.map((c) => {
    const col = c === '__rowid__' && dialect === 'sqlite' ? 'rowid' : quoteIdent(dialect, c);
    return where[c] === null ? `${col} IS NULL` : `${col} = ${ph(where[c])}`;
  }).join(' AND ');
  return { sql: `UPDATE ${quoteTable(dialect, table)} SET ${setSql} WHERE ${whereSql}`, params };
}

// Strip comments and quoted literals so keyword checks cannot be fooled by their content.
function stripSql(sql) {
  return String(sql)
    .replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""').replace(/`[^`]*`/g, '``')
    .replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}
// Defence in depth only: engines additionally enforce read-only (READ ONLY transaction / query_only).
function isReadOnlySql(sql) {
  const stmts = stripSql(sql).split(';').map((s) => s.trim()).filter(Boolean);
  if (!stmts.length) return false;
  return stmts.every((s) => {
    const kw = (/^\(*\s*([a-z]+)/i.exec(s) || [])[1];
    if (!kw) return false;
    const k = kw.toLowerCase();
    if (k === 'pragma') return !/=/.test(s) && !/query_only|writable_schema/i.test(s);
    if (k === 'explain') return !/\banalyze\b/i.test(s) || /^explain\s+analyze\s+select\b/i.test(s);
    return ['select', 'with', 'show', 'describe', 'desc', 'values', 'table'].includes(k);
  });
}

// Validate/normalise a saved-connection record. Never accepts or returns a password.
function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'Invalid connection.' };
  const name = typeof cfg.name === 'string' ? cfg.name.trim() : '';
  if (!name || name.length > 80) return { ok: false, error: 'Name is required (max 80 characters).' };
  if (!DRIVERS.includes(cfg.driver)) return { ok: false, error: 'Unknown driver.' };
  if (cfg.id != null && !/^[a-f0-9]{8,32}$/.test(String(cfg.id))) return { ok: false, error: 'Invalid connection id.' };
  const out = { name, driver: cfg.driver, allowWrites: cfg.allowWrites === true };
  if (cfg.id != null) out.id = String(cfg.id);
  if (cfg.driver === 'sqlite') {
    if (typeof cfg.file !== 'string' || !cfg.file || cfg.file.includes('\0')) return { ok: false, error: 'Database file is required.' };
    out.file = cfg.file;
    return { ok: true, config: out };
  }
  const host = typeof cfg.host === 'string' ? cfg.host.trim() : '';
  if (!host || host.length > 255 || /[\s/\\\0]/.test(host)) return { ok: false, error: 'Invalid host.' };
  const port = cfg.port === undefined || cfg.port === '' || cfg.port === null ? DEFAULT_PORT[cfg.driver] : Number(cfg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Port must be 1-65535.' };
  for (const k of ['user', 'database']) {
    if (cfg[k] != null && (typeof cfg[k] !== 'string' || cfg[k].length > 256 || cfg[k].includes('\0'))) return { ok: false, error: `Invalid ${k}.` };
  }
  if (!cfg.user || !String(cfg.user).trim()) return { ok: false, error: 'User is required.' };
  Object.assign(out, { host, port, user: String(cfg.user).trim(), database: typeof cfg.database === 'string' ? cfg.database.trim() : '', ssl: cfg.ssl === true });
  return { ok: true, config: out };
}

module.exports = { DRIVERS, DEFAULT_PORT, MAX_ROWS, EXPORT_MAX_ROWS, STATEMENT_TIMEOUT_MS, quoteIdent, normTable, quoteTable, clampLimit, clampOffset, cell, csvField, toCsv, buildUpdate, isReadOnlySql, validateConfig };
