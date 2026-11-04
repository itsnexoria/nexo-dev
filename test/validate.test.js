const test = require('node:test');
const assert = require('node:assert');
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { isSafeName, isSafeGitRef, isSafeExternalUrl } = require('../lib/validate');
const { startLiveServer } = require('../lib/liveserver');

test('isSafeName rejects traversal and separators', () => {
  for (const bad of ['', ' ', '.', '..', '../x', 'a/b', 'a\\b', 'a\0b', null, 5]) assert.equal(isSafeName(bad), false, String(bad));
  for (const ok of ['a.txt', '.env', 'my file (1).js']) assert.equal(isSafeName(ok), true, ok);
});
test('isSafeGitRef rejects option-like and whitespace refs', () => {
  for (const bad of ['--upload-pack=x', '-b', '', 'a b', 'a\nb', undefined]) assert.equal(isSafeGitRef(bad), false, String(bad));
  for (const ok of ['main', 'feature/x', 'v1.2.3']) assert.equal(isSafeGitRef(ok), true, ok);
});
test('isSafeExternalUrl allows only http(s)/mailto', () => {
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ms-msdt:/x', 'smb://h/s', 'nonsense', '']) assert.equal(isSafeExternalUrl(bad), false, bad);
  for (const ok of ['https://a.com', 'http://localhost:3000/x', 'mailto:a@b.c']) assert.equal(isSafeExternalUrl(ok), true, ok);
});
test('liveserver: rebinding Host rejected, dotfiles hidden', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
  fs.writeFileSync(path.join(dir, 'index.html'), 'ok'); fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(dir, '.git')); fs.writeFileSync(path.join(dir, '.git', 'config'), 'x');
  const s = await startLiveServer({ root: dir });
  const get = (p, host) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: s.port, path: p, headers: host ? { Host: host } : {}, agent: false }, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));
  assert.equal((await get('/', 'evil.example.com')).status, 421);
  assert.equal((await get('/', null)).status, 200);
  assert.equal((await get('/.env')).status, 403);
  assert.equal((await get('/.git/config')).status, 403);
  await s.close();
});
