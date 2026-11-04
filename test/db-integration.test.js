// Runs against a real PostgreSQL when NEXO_TEST_PG=host:port:user:db is set (skipped otherwise);
// MySQL logic is covered by the pure-helper tests in db.test.js (no server available in CI here).
const test = require('node:test');
const assert = require('node:assert');
const { PgImpl } = require('../lib/db/pg-impl');

const spec = process.env.NEXO_TEST_PG;
test('postgres: browse, edit by primary key, read-only enforcement', { skip: !spec }, async () => {
  const [host, port, user, database] = spec.split(':');
  const impl = new PgImpl();
  await impl.open({ host, port: +port, user, database, allowWrites: true }, '');
  await impl.query('DROP TABLE IF EXISTS nexo_t');
  await impl.query('CREATE TABLE nexo_t (id serial PRIMARY KEY, name text, n int)');
  await impl.query("INSERT INTO nexo_t (name, n) VALUES ('a', 1), ('b', NULL)");
  const tables = await impl.listTables();
  assert.ok(tables.some((t) => t.name === 'nexo_t'));
  const b = await impl.browse('nexo_t', 10, 0);
  assert.deepEqual(b.columns, ['id', 'name', 'n']);
  assert.equal(b.editable, true);
  assert.deepEqual(b.rowKeys[0], { id: 1 });
  await impl.updateCell({ table: 'nexo_t', set: { name: 'z' }, where: { id: 1 } });
  assert.equal((await impl.query("SELECT name FROM nexo_t WHERE id = 1")).rows[0][0], 'z');
  await assert.rejects(impl.updateCell({ table: 'nexo_t', set: { name: 'q' }, where: { id: 999 } }), /matched 0 rows/);
  await impl.setWrites(false);
  await assert.rejects(impl.query('DELETE FROM nexo_t'), /Read-only/);
  await assert.rejects(impl.client.query('DELETE FROM nexo_t'), /read-only transaction/);
  await impl.setWrites(true);
  await impl.query('DROP TABLE nexo_t');
  await impl.close();
});
