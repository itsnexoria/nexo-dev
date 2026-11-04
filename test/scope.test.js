const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Scope, installGuard } = require('../lib/scope');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
const root = path.join(tmp, 'proj'); const other = path.join(tmp, 'other');
fs.mkdirSync(root); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 's.txt'), 'x');

test('allows paths inside a root, rejects outside and traversal', () => {
  const s = new Scope(); s.addRoot(root);
  assert.ok(s.allows(root)); assert.ok(s.allows(path.join(root, 'a', 'b.txt')));
  assert.ok(!s.allows(other)); assert.ok(!s.allows(path.join(root, '..', 'other', 's.txt')));
  assert.ok(!s.allows(root + '-evil')); assert.ok(!s.allows('')); assert.ok(!s.allows(null)); assert.ok(!s.allows(root + '\0x'));
});
test('symlink escaping the root is rejected', { skip: process.platform === 'win32' }, () => {
  const s = new Scope(); s.addRoot(root);
  fs.symlinkSync(other, path.join(root, 'link'));
  assert.ok(!s.allows(path.join(root, 'link', 's.txt')));
});
test('read-only roots permit reads only', () => {
  const s = new Scope({ readOnlyRoots: [other] });
  assert.ok(s.allows(path.join(other, 's.txt'), { write: false })); assert.ok(!s.allows(path.join(other, 's.txt')));
});
test('installGuard blocks untrusted senders and out-of-scope paths', async () => {
  const handlers = {}; const ipc = { handle: (c, f) => { handlers[c] = f; } };
  const s = new Scope(); s.addRoot(root);
  installGuard(ipc, { scope: s, isTrustedSender: (e) => e.ok });
  let ran = 0; ipc.handle('fs:read-file', () => { ran++; return { ok: true }; });
  assert.equal((await handlers['fs:read-file']({ ok: false }, path.join(root, 'a'))).error, 'Untrusted sender.');
  assert.equal((await handlers['fs:read-file']({ ok: true }, '/etc/passwd')).code, 'EOUTSCOPE');
  assert.equal((await handlers['fs:read-file']({ ok: true }, path.join(root, 'a'))).ok, true);
  assert.equal(ran, 1);
});
