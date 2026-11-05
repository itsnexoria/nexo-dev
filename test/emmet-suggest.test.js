const test = require('node:test');
const assert = require('node:assert');
const emmet = require('emmet');
const { suggest, supports } = require('../lib/emmet-suggest');

const api = { expand: emmet.default, extract: emmet.extract };
test('expands html abbreviations at the cursor', () => {
  const line = '  <div>ul>li*2.item';
  const r = suggest(api, 'html', line, line.length);
  assert.strictEqual(r.abbr, 'ul>li*2.item');
  assert.strictEqual(line.slice(r.start, r.end), 'ul>li*2.item');
  assert.match(r.text, /<ul>[\s\S]*<li class="item">[\s\S]*<\/ul>/);
});
test('expands css abbreviations', () => {
  const line = '  m10';
  const r = suggest(api, 'css', line, line.length);
  assert.ok(r && /margin: 10px/.test(r.text), JSON.stringify(r));
});
test('ignores unsupported languages, empty lines and no-op results', () => {
  assert.strictEqual(suggest(api, 'python', 'ul>li', 5), null);
  assert.strictEqual(suggest(api, 'html', '', 0), null);
  assert.strictEqual(suggest(api, 'html', '   ', 3), null);
  assert.strictEqual(suggest(null, 'html', 'div', 3), null);
  assert.ok(supports('scss') && !supports('markdown'));
});
