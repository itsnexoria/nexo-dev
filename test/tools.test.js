const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const { startLiveServer, resolveSafe } = require('../lib/liveserver');
const { sendRequest } = require('../lib/httpclient');
const sqlite = require('../lib/sqlite');

const get = (url) => new Promise((res, rej) => http.get(url, { agent: false }, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => res({ status: r.statusCode, body: b, headers: r.headers })); }).on('error', rej));

test('liveserver: serves, injects reload client, blocks traversal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>hi</body></html>');
  fs.writeFileSync(path.join(os.tmpdir(), 'secret-ls.txt'), 'secret');
  const s = await startLiveServer({ root: dir });
  const r = await get(s.url);
  assert.equal(r.status, 200); assert.match(r.body, /__nexo_live/);
  const esc = await get(s.url + '..%2Fsecret-ls.txt'); assert.notEqual(esc.body, 'secret'); assert.ok([403, 404].includes(esc.status));
  assert.equal((await get(s.url + 'nope.js')).status, 404);
  assert.equal(resolveSafe(dir, '/../x'), path.join(dir, 'x'));
  await s.close();
});
test('liveserver: file change broadcasts reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
  fs.writeFileSync(path.join(dir, 'index.html'), 'x');
  const s = await startLiveServer({ root: dir });
  const got = await new Promise((resolve) => {
    http.get(s.url + '__nexo_live', { agent: false }, (res) => {
      res.on('data', (d) => { if (String(d).includes('reload')) { resolve(true); res.destroy(); } });
      setTimeout(() => fs.writeFileSync(path.join(dir, 'index.html'), 'y'), 100);
      setTimeout(() => resolve(false), 3000);
    });
  });
  assert.ok(got); await s.close();
});
test('httpclient: round trip + validation', async () => {
  const srv = http.createServer((q, r) => { let b = ''; q.on('data', (d) => b += d); q.on('end', () => { r.setHeader('x-a', '1'); r.end(q.method + ':' + b); }); }).listen(0);
  const port = srv.address().port;
  const r = await sendRequest({ method: 'POST', url: `http://127.0.0.1:${port}/`, body: 'abc' });
  assert.equal(r.status, 200); assert.equal(r.body, 'POST:abc'); assert.equal(r.headers['x-a'], '1');
  assert.equal((await sendRequest({ url: 'file:///etc/passwd' })).ok, false);
  assert.equal((await sendRequest({ url: 'nope' })).ok, false);
  srv.close();
});
test('sqlite: list/browse/query, in-memory only', async () => {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const d = new SQL.Database(); d.run('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t(name) VALUES ("a"),("b");');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'x.sqlite'); fs.writeFileSync(f, Buffer.from(d.export()));
  const tables = await sqlite.listTables(f);
  assert.deepEqual(tables.map((t) => [t.name, t.count]), [['t', 2]]);
  assert.equal((await sqlite.browseTable(f, 't')).rows.length, 2);
  assert.equal((await sqlite.tableSchema(f, 't'))[0].pk, true);
  await sqlite.runQuery(f, 'DELETE FROM t');
  assert.equal(fs.statSync(f).size, Buffer.from(d.export()).length); // file untouched
  sqlite.closeAll();
});
