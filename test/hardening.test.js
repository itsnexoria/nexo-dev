const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Scope, installGuard } = require('../lib/scope');
const { TrustStore } = require('../lib/trust');
const secure = require('../lib/secure');
const textio = require('../lib/textio');
const C = require('../lib/db/common');
const G = require('../lib/git-parse');
const { validateManifest } = require('../lib/extensions');
const { SqliteProxy } = require('../lib/db/sqlite-proxy');
const { runJob } = require('../lib/search-runner');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-'));

test('trust store: trust a folder and its children, persist, revoke', () => {
  const f = path.join(tmp, 'trust.json'); const proj = path.join(tmp, 'p'); fs.mkdirSync(proj);
  const t = new TrustStore(f);
  assert.ok(!t.isTrusted(proj));
  t.add(proj);
  assert.ok(t.isTrusted(path.join(proj, 'sub', 'x'))); assert.ok(!t.isTrusted(proj + '-evil'));
  assert.ok(new TrustStore(f).isTrusted(proj));
  t.remove(proj); assert.ok(!t.isTrusted(proj));
  assert.ok(new TrustStore(f, { trustAll: true }).isTrusted('/anything'));
});

test('guard refuses project-tool channels in untrusted folders', async () => {
  const handlers = {}; const ipc = { handle: (c, fn) => { handlers[c] = fn; } };
  const s = new Scope(); const proj = path.join(tmp, 'g'); fs.mkdirSync(proj); s.addRoot(proj);
  const trust = new TrustStore(path.join(tmp, 'g.json'));
  installGuard(ipc, { scope: s, isTrustedSender: () => true, trust });
  ipc.handle('eslint:lint', () => ({ ok: true })); ipc.handle('lsp:start', () => ({ ok: true })); ipc.handle('fs:stat', () => ({ ok: true }));
  assert.equal((await handlers['eslint:lint']({}, proj, path.join(proj, 'a.js'))).code, 'EUNTRUSTED');
  assert.equal((await handlers['lsp:start']({}, 'python', proj)).code, 'EUNTRUSTED');
  assert.equal((await handlers['fs:stat']({}, proj)).ok, true);
  trust.add(proj);
  assert.equal((await handlers['eslint:lint']({}, proj, path.join(proj, 'a.js'))).ok, true);
});

test('secure.usable rejects basic_text backend on linux', () => {
  const mk = (avail, backend) => ({ isEncryptionAvailable: () => avail, getSelectedStorageBackend: () => backend });
  assert.equal(secure.usable(mk(false, 'gnome_libsecret')), false);
  if (process.platform === 'linux') { assert.equal(secure.usable(mk(true, 'basic_text')), false); assert.equal(secure.usable(mk(true, 'gnome_libsecret')), true); }
});

test('textio round-trips non-UTF-8 bytes losslessly', () => {
  const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0xff]);
  const { text, encoding } = textio.decodeText(bytes);
  assert.equal(encoding, 'latin1');
  assert.deepEqual(textio.encodeText(text, encoding), bytes);
  assert.equal(textio.decodeText(Buffer.from('café', 'utf8')).encoding, 'utf8');
  assert.deepEqual(textio.encodeText('€', 'latin1'), Buffer.from('€', 'utf8')); // can't be latin1 any more
});

test('csv export neutralises formulas but keeps numbers', () => {
  assert.equal(C.csvField('=1+1'), "'=1+1");
  assert.equal(C.csvField('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(C.csvField('-5'), '-5'); assert.equal(C.csvField(-5), '-5'); assert.equal(C.csvField('hello'), 'hello');
});

test('git status -z: spaces, unicode, renames', () => {
  const r = G.parsePorcelainStatusZ('R  new name.txt\0old.txt\0 M sp ace.js\0?? ü.txt\0UU c.txt\0');
  assert.equal(r.staged[0].path, 'new name.txt'); assert.equal(r.staged[0].renamedFrom, 'old.txt');
  assert.deepEqual(r.unstaged.map((x) => x.path), ['sp ace.js', 'ü.txt']); assert.equal(r.conflicts[0].path, 'c.txt');
});

test('extension manifest permissions are validated', () => {
  const base = { id: 'x', name: 'X', version: '1.0.0' };
  assert.deepEqual(validateManifest({ ...base, permissions: ['editor.read', 'editor.read'] }).manifest.permissions, ['editor.read']);
  assert.ok(!validateManifest({ ...base, permissions: ['root'] }).ok);
  assert.deepEqual(validateManifest(base).manifest.permissions, []);
});

test('sqlite runs in a worker and a runaway query is killed', async () => {
  const file = path.join(tmp, 'a.sqlite');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm')) });
  const d = new SQL.Database(); d.run('CREATE TABLE t(a)'); d.run('INSERT INTO t VALUES (1),(2)'); fs.writeFileSync(file, Buffer.from(d.export()));
  const p = new SqliteProxy();
  await p.open(file, false);
  assert.equal((await p.query('SELECT COUNT(*) FROM t')).rows[0][0], 2);
  await assert.rejects(p.query('DELETE FROM t'), /Read-only/);
  const q = p._call.bind(p);
  p._call = (m, a) => q(m, a, 800); // short timeout for the test
  await assert.rejects(p.query('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT COUNT(*) FROM c'), /timed out/);
  await assert.rejects(p.query('SELECT 1'), /timed out|Closed/);
  await p.close();
});

test('regex search worker: results, and a catastrophic pattern times out instead of hanging', async () => {
  const dir = path.join(tmp, 'srch'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello world\n'); fs.writeFileSync(path.join(dir, 'b.txt'), 'a'.repeat(40) + '!\n');
  const ok = await runJob({ kind: 'search', root: dir, query: 'wor.d', opts: { useRegex: true } });
  assert.equal(ok.results.matches.length, 1);
  const bad = await runJob({ kind: 'search', root: dir, query: '^(a+)+$', opts: { useRegex: true } }, { timeoutMs: 1500 });
  assert.equal(bad.timedOut, true);
});

test('replace skips non-UTF-8 files', async () => {
  const dir = path.join(tmp, 'rep'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'u.txt'), 'foo'); fs.writeFileSync(path.join(dir, 'l.txt'), Buffer.from([0x66, 0x6f, 0x6f, 0xe9]));
  const written = [];
  const r = await runJob({ kind: 'replace', root: dir, query: 'foo', replacement: 'bar', opts: {} }, { onWritten: (p) => written.push(p) });
  assert.equal(r.results.filesChanged, 1); assert.equal(r.results.skipped, 1); assert.equal(written.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'l.txt')), Buffer.from([0x66, 0x6f, 0x6f, 0xe9]));
});
