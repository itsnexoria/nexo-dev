const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const C = require('../lib/db/common');
const { createManager } = require('../lib/db/manager');

test('quoteIdent / quoteTable per dialect', () => {
  assert.equal(C.quoteIdent('postgres', 'a"b'), '"a""b"');
  assert.equal(C.quoteIdent('mysql', 'a`b'), '`a``b`');
  assert.equal(C.quoteTable('postgres', { schema: 'public', name: 't' }), '"public"."t"');
  assert.throws(() => C.quoteIdent('mysql', ''));
});

test('buildUpdate: parameter style, NULL keys, no-where rejected', () => {
  const pg = C.buildUpdate('postgres', 't', { a: 1, b: 2 }, { id: 5 });
  assert.equal(pg.sql, 'UPDATE "t" SET "a" = $1, "b" = $2 WHERE "id" = $3');
  assert.deepEqual(pg.params, [1, 2, 5]);
  const my = C.buildUpdate('mysql', 't', { a: 1 }, { id: null });
  assert.equal(my.sql, 'UPDATE `t` SET `a` = ? WHERE `id` IS NULL');
  assert.equal(C.buildUpdate('sqlite', 't', { a: 1 }, { __rowid__: 3 }).sql, 'UPDATE "t" SET "a" = ? WHERE rowid = ?');
  assert.throws(() => C.buildUpdate('mysql', 't', { a: 1 }, {}), /primary key/);
});

test('isReadOnlySql is not fooled by comments, literals or stacked statements', () => {
  for (const ok of ['SELECT 1', 'with x as (select 1) select * from x', 'SHOW TABLES', 'EXPLAIN SELECT 1', "select 'a; drop table t'", '-- c\nselect 1']) assert.ok(C.isReadOnlySql(ok), ok);
  for (const bad of ['DROP TABLE t', 'select 1; delete from t', 'UPDATE t SET a=1', 'PRAGMA writable_schema = 1', 'explain analyze delete from t', '', 'insert into t values (1)']) assert.ok(!C.isReadOnlySql(bad), bad);
});

test('toCsv quotes per RFC 4180', () => {
  assert.equal(C.toCsv(['a', 'b'], [['x,y', 'q"z'], [null, 1]]), 'a,b\r\n"x,y","q""z"\r\n,1\r\n');
});

test('validateConfig rejects bad input and never echoes a password', () => {
  assert.equal(C.validateConfig({ name: 'x', driver: 'nope' }).ok, false);
  assert.equal(C.validateConfig({ name: 'x', driver: 'postgres', host: 'a b', user: 'u' }).ok, false);
  assert.equal(C.validateConfig({ name: 'x', driver: 'mysql', host: 'h', port: 70000, user: 'u' }).ok, false);
  const v = C.validateConfig({ name: 'x', driver: 'mysql', host: 'h', user: 'u', password: 'secret' });
  assert.ok(v.ok); assert.equal(v.config.port, 3306); assert.ok(!('password' in v.config));
});

test('manager: passwords stored only encrypted; sqlite end to end', async () => {
  let blob = {};
  const secrets = { encrypt: (s) => 'ENC(' + Buffer.from(s).toString('base64') + ')', decrypt: (s) => Buffer.from(s.slice(4, -1), 'base64').toString() };
  const mgr = createManager({ store: { read: () => blob, write: (o) => { blob = JSON.parse(JSON.stringify(o)); } }, secrets });
  const r = mgr.save({ name: 'pg', driver: 'postgres', host: 'localhost', user: 'u' }, 'hunter2');
  assert.ok(r.ok);
  assert.ok(!JSON.stringify(blob).includes('hunter2'));
  assert.equal(mgr.list()[0].hasPassword, true);
  assert.ok(!('pw' in mgr.list()[0]));
  mgr.save({ id: r.id, name: 'pg2', driver: 'postgres', host: 'localhost', user: 'u' }); // keep the password when none supplied
  assert.equal(mgr.list()[0].name, 'pg2'); assert.equal(mgr.list()[0].hasPassword, true);
  mgr.remove(r.id); assert.equal(mgr.list().length, 0);

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const d = new SQL.Database(); d.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1,\'a\'),(2,\'b\');');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-')), 'x.sqlite'); fs.writeFileSync(f, Buffer.from(d.export()));
  const id = await mgr.connectConfig({ driver: 'sqlite', name: 'x', file: f, allowWrites: false });
  const impl = mgr.get(id).impl;
  const b = impl.browse('t', 10, 0);
  assert.equal(b.rows.length, 2); assert.equal(b.editable, true);
  assert.throws(() => impl.updateCell({ table: 't', set: { v: 'z' }, where: b.rowKeys[0] }), /read-only/i);
  assert.throws(() => impl.query('DELETE FROM t'), /Read-only/);
  await mgr.setWrites(id, true);
  impl.updateCell({ table: 't', set: { v: 'z' }, where: b.rowKeys[0] });
  assert.equal(impl.query('SELECT v FROM t WHERE id=1').rows[0][0], 'z');
  assert.throws(() => impl.updateCell({ table: 't', set: { v: 'z' }, where: { id: 99 } }), /matched 0 rows/);
  await mgr.disconnect(id);
  assert.throws(() => mgr.get(id), /Not connected/);
});
