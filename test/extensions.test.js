const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { validateManifest, scan } = require('../lib/extensions');
const good = { id: 'hello', name: 'Hello', version: '1.0.0', main: 'main.js', commands: [{ id: 'hi', title: 'Say Hi' }] };
test('valid manifest', () => assert.ok(validateManifest(good).ok));
test('rejects bad id, main traversal, bad theme color', () => {
  assert.ok(!validateManifest({ ...good, id: '../x' }).ok);
  assert.ok(!validateManifest({ ...good, main: '../evil.js' }).ok);
  assert.ok(!validateManifest({ ...good, main: '/abs.js' }).ok);
  assert.ok(!validateManifest({ ...good, themes: [{ id: 't', name: 'T', base: 'vs', colors: { a: 'url(x)' } }] }).ok);
  assert.ok(!validateManifest(null).ok);
});
test('scan loads, flags errors and disabled', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-'));
  fs.mkdirSync(path.join(d, 'hello')); fs.writeFileSync(path.join(d, 'hello/manifest.json'), JSON.stringify(good)); fs.writeFileSync(path.join(d, 'hello/main.js'), 'x');
  fs.mkdirSync(path.join(d, 'bad')); fs.writeFileSync(path.join(d, 'bad/manifest.json'), '{');
  fs.mkdirSync(path.join(d, 'wrong')); fs.writeFileSync(path.join(d, 'wrong/manifest.json'), JSON.stringify({ ...good, id: 'other' }));
  const r = scan(d, ['hello']); const by = Object.fromEntries(r.map((e) => [e.id, e]));
  assert.equal(by.hello.enabled, false); assert.equal(by.hello.code, 'x');
  assert.ok(by.bad.error); assert.match(by.wrong.error, /folder name/);
});
