const test = require('node:test');
const assert = require('node:assert');
const { tokenize, parseCurl, toCurl } = require('../lib/curl-parse');

test('tokenize handles quotes, escapes and continuations', () => {
  assert.deepStrictEqual(tokenize("a 'b c' \"d\\\"e\" f\\ g"), ['a', 'b c', 'd"e', 'f g']);
  assert.deepStrictEqual(tokenize('a \\\nb'), ['a', 'b']);
  assert.deepStrictEqual(tokenize("$'x\\ny'"), ['x\ny']);
  assert.throws(() => tokenize("'open"));
});
test('parseCurl extracts method, url, headers and body', () => {
  const r = parseCurl("curl -X POST https://a.com/x -H 'Content-Type: application/json' -d '{\"a\":1}'");
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.url, 'https://a.com/x');
  assert.deepStrictEqual(r.headers, [{ name: 'Content-Type', value: 'application/json' }]);
  assert.strictEqual(r.body, '{"a":1}');
});
test('-u becomes a Basic auth header and -G moves data to the query', () => {
  const r = parseCurl('curl -u me:pw https://a.com -G -d q=1');
  assert.strictEqual(r.method, 'GET');
  assert.strictEqual(r.url, 'https://a.com?q=1');
  assert.strictEqual(r.headers[0].value, 'Basic ' + Buffer.from('me:pw').toString('base64'));
});
test('toCurl round-trips', () => {
  const r = parseCurl("curl -X POST https://a.com/x -H 'A: b' -d 'k=v'");
  const r2 = parseCurl(toCurl(r));
  assert.deepStrictEqual({ ...r2, warnings: [] }, { ...r, warnings: [] });
});
