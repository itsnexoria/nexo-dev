const test = require('node:test');
const assert = require('node:assert');
const { computeGraph } = require('../lib/git-graph');
const { parse } = require('../lib/workspace');
const { parseDiff } = require('../lib/git-patch');

test('computeGraph assigns lanes for a merge', () => {
  const g = computeGraph([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a', 'x'] },
    { hash: 'x', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  assert.deepStrictEqual(g.map((n) => n.lane), [0, 0, 1, 0]);
  assert.strictEqual(g[1].outgoing.length, 2);
  assert.strictEqual(g[3].outgoing.length, 0);
});
test('workspace.parse resolves relative and absolute folders', () => {
  assert.deepStrictEqual(parse('/w/a.nexo-workspace', '{"folders":["./p",{"path":"/abs/"},"./p"]}'), ['/w/p', '/abs']);
  assert.deepStrictEqual(parse('C:\\w\\a.nexo-workspace', '{"folders":["p"]}'), ['C:\\w\\p']);
});
test('workspace.parse rejects bad input', () => {
  assert.throws(() => parse('/w/a', 'nope'), /valid JSON/);
  assert.throws(() => parse('/w/a', '{"folders":[]}'), /no folders/);
  assert.throws(() => parse('/w/a', '{"folders":[" "]}'), /usable/);
});
test('parseDiff reads hunks', () => {
  const d = parseDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n');
  assert.strictEqual(d.hunks.length, 1);
  assert.deepStrictEqual(d.hunks[0].lines.map((l) => l.t), [' ', '-', '+']);
});
