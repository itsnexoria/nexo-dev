const test = require('node:test');
const assert = require('node:assert');
const { PtyManager } = require('../lib/pty');

test('pty: spawn, echo, resize, exit', { skip: process.platform === 'win32' }, async () => {
  let out = '';
  let exited;
  const done = new Promise((r) => { exited = r; });
  const m = new PtyManager({ onData: (id, d) => { out += d; }, onExit: (id, code) => exited(code) });
  assert.ok(m.available);
  const { id } = m.spawn({ cwd: '/tmp', shell: '/bin/sh' });
  m.resize(id, 100, 30);
  m.write(id, 'echo nexo-$((20+22))\r');
  await new Promise((r) => setTimeout(r, 500));
  assert.match(out, /nexo-42/);
  m.write(id, 'exit\r');
  assert.equal(await done, 0);
});
test('pty: bad cwd falls back to home, kill works', () => {
  const m = new PtyManager({ onData() {}, onExit() {} });
  const { id } = m.spawn({ cwd: '/definitely/not/here', shell: process.platform === 'win32' ? undefined : '/bin/sh' });
  assert.ok(m.sessions.has(id));
  m.killAll();
  assert.equal(m.sessions.size, 0);
});
