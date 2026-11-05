const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { install, binDir } = require('../lib/lsp-install');
const { SERVERS, managedPackages, defaultServers } = require('../lib/lsp-servers');
const { findExecutable } = require('../lib/lsp');

function fakeSpawn(code, log) {
  return (cmd, args) => {
    log.push({ cmd, args });
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
    setImmediate(() => { c.stderr.emit('data', 'boom'); c.emit('close', code); });
    return c;
  };
}

test('registry: unique ids, shape, and managed packages match the npm hint', () => {
  assert.strictEqual(new Set(SERVERS.map((s) => s.id)).size, SERVERS.length);
  for (const s of SERVERS) {
    assert.ok(s.command && Array.isArray(s.args) && s.langs.length && s.install, s.id);
    if (s.install.npm) assert.deepStrictEqual(managedPackages(s), s.install.npm.replace('npm i -D ', '').split(' '));
    else assert.strictEqual(managedPackages(s), null);
  }
  for (const l of ['dockerfile', 'sql', 'csharp', 'kotlin', 'swift']) assert.ok(defaultServers()[l], l);
});
test('install: runs npm with a private prefix, no scripts, only known packages', async () => {
  const log = [];
  const r = await install('pyright', { dir: '/data/lsp', find: () => '/usr/bin/npm', spawn: fakeSpawn(0, log) });
  assert.deepStrictEqual(r, { ok: true, packages: ['pyright'] });
  assert.strictEqual(log[0].cmd, '/usr/bin/npm');
  assert.deepStrictEqual(log[0].args.slice(0, 3), ['install', '--prefix', '/data/lsp']);
  assert.ok(log[0].args.includes('--ignore-scripts'));
  assert.strictEqual(log[0].args.at(-1), 'pyright');
});
test('install: rejects unknown ids, manual-only servers, missing npm; reports failures', async () => {
  const log = [];
  const base = { dir: '/d', find: () => '/n', spawn: fakeSpawn(0, log) };
  assert.match((await install('rm -rf /', base)).error, /Unknown/);
  assert.match((await install('gopls', base)).error, /cannot be installed automatically/);
  assert.match((await install('pyright', { ...base, find: () => null })).error, /npm was not found/);
  const bad = await install('pyright', { ...base, spawn: fakeSpawn(1, []) });
  assert.strictEqual(bad.ok, false); assert.match(bad.output, /boom/);
  assert.strictEqual(log.length, 0);
});
test('findExecutable also searches the managed install dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lspi-'));
  fs.mkdirSync(binDir(dir), { recursive: true });
  const exe = path.join(binDir(dir), process.platform === 'win32' ? 'zzfake-ls.cmd' : 'zzfake-ls');
  fs.writeFileSync(exe, '');
  assert.strictEqual(findExecutable('zzfake-ls', null), null);
  assert.strictEqual(findExecutable('zzfake-ls', null, [binDir(dir)]), exe);
});
