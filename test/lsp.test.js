const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { MessageParser, frame, LspManager, findExecutable } = require('../lib/lsp');
const { sanitizePrefsPartial } = require('../lib/prefs');

test('lsp: parser handles split chunks, multiple messages, non-ASCII', () => {
  const got = [];
  const p = new MessageParser((m) => got.push(m));
  const all = Buffer.concat([frame({ a: 'é✓' }), frame({ b: 2 })]);
  for (let i = 0; i < all.length; i += 7) p.push(all.subarray(i, i + 7));
  assert.deepEqual(got, [{ a: 'é✓' }, { b: 2 }]);
});
test('lsp: manager round-trips with a fake server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-'));
  const srv = path.join(dir, 'fake-ls.js');
  fs.writeFileSync(srv, `#!/usr/bin/env node
let b=Buffer.alloc(0);process.stdin.on('data',d=>{b=Buffer.concat([b,d]);const i=b.indexOf('\\r\\n\\r\\n');if(i<0)return;const n=+/Content-Length: *(\\d+)/.exec(b.toString())[1];if(b.length<i+4+n)return;const m=JSON.parse(b.subarray(i+4,i+4+n));b=b.subarray(i+4+n);const o=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{echo:m.method}}));process.stdout.write('Content-Length: '+o.length+'\\r\\n\\r\\n');process.stdout.write(o);});`);
  fs.chmodSync(srv, 0o755);
  const msgs = []; let exit;
  const m = new LspManager({ onMessage: (id, msg) => msgs.push(msg), onExit: (id, c) => { exit = c; }, getUserServers: () => ({ fake: { command: srv, args: [] } }) });
  const r = m.start('fake', dir);
  assert.ok(r.ok, r.error);
  m.send(r.id, { jsonrpc: '2.0', id: 1, method: 'ping' });
  await new Promise((res) => setTimeout(res, 400));
  assert.deepEqual(msgs[0].result, { echo: 'ping' });
  m.stop(r.id);
});
test('lsp: unconfigured/missing servers give clear errors; ts is opt-in', () => {
  const m = new LspManager({ onMessage() {}, onExit() {}, getUserServers: () => ({}) });
  assert.equal(m.start('klingon', os.tmpdir()).code, 'unconfigured');
  assert.equal(m.start('typescript', os.tmpdir()).code, 'unconfigured');
  const r = new LspManager({ onMessage() {}, onExit() {}, getUserServers: () => ({ go: { command: 'definitely-not-installed-xyz' } }) }).start('go', os.tmpdir());
  assert.equal(r.code, 'missing');
});
test('lsp: prefs sanitizer', () => {
  const c = sanitizePrefsPartial({ lspServers: { 'ba d': { command: 'x' }, go: { command: ' gopls ', args: ['a', 5] }, rust: {} } });
  assert.deepEqual(c.lspServers, { go: { command: 'gopls', args: ['a'] } });
});
