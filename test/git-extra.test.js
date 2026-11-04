const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const { parseDiff, buildPatch } = require('../lib/git-patch');
const { computeGraph } = require('../lib/git-graph');
const { register } = require('../lib/ipc-git-extra');

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf-8' });
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-'));
  sh(d, 'init', '-q', '-b', 'main'); sh(d, 'config', 'user.email', 't@t'); sh(d, 'config', 'user.name', 't');
  return d;
}
const handlers = {};
register({ ipcMain: { handle: (c, f) => { handlers[c] = f; } } });
const call = (c, ...a) => handlers[c]({}, ...a);

test('parseDiff + buildPatch: select one of two hunks', () => {
  const diff = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,3 +10,3 @@\n x\n-y\n+Y\n z\n';
  const p = parseDiff(diff);
  assert.equal(p.hunks.length, 2);
  const patch = buildPatch(p, [{ hunk: 1 }]);
  assert.ok(patch.includes('+Y') && !patch.includes('+B'));
  assert.equal(buildPatch(p, []), null);
});

test('computeGraph: merge produces two lanes', () => {
  const rows = computeGraph([
    { hash: 'm', parents: ['a', 'b'] }, { hash: 'a', parents: ['r'] }, { hash: 'b', parents: ['r'] }, { hash: 'r', parents: [] },
  ]);
  assert.equal(rows.length, 4);
  assert.ok(Math.max(...rows.map((r) => r.laneCount)) >= 2);
});

test('stage a single hunk, unstage it, discard another (real git)', async () => {
  const d = repo();
  const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
  fs.writeFileSync(path.join(d, 'f.txt'), lines.join('\n') + '\n');
  sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'init');
  const edited = lines.slice(); edited[1] = 'CHANGED2'; edited[25] = 'CHANGED26';
  fs.writeFileSync(path.join(d, 'f.txt'), edited.join('\n') + '\n');
  const h = await call('git:hunks', d, 'f.txt', false);
  assert.equal(h.hunks.length, 2);
  let r = await call('git:apply-selection', d, 'f.txt', 'stage', [{ hunk: 0 }]);
  assert.ok(r.ok, r.error);
  assert.match(sh(d, 'diff', '--cached'), /CHANGED2/);
  assert.doesNotMatch(sh(d, 'diff', '--cached'), /CHANGED26/);
  r = await call('git:apply-selection', d, 'f.txt', 'unstage', [{ hunk: 0 }]);
  assert.ok(r.ok, r.error);
  assert.equal(sh(d, 'diff', '--cached').trim(), '');
  r = await call('git:apply-selection', d, 'f.txt', 'discard', [{ hunk: 1 }]);
  assert.ok(r.ok, r.error);
  const now = fs.readFileSync(path.join(d, 'f.txt'), 'utf-8');
  assert.ok(now.includes('CHANGED2') && !now.includes('CHANGED26'));
  const v = await call('git:file-versions', d, 'f.txt', false);
  assert.ok(v.original.includes('line2') && v.modified.includes('CHANGED2'));
});

test('stash push/list/show/pop, graph and history (real git)', async () => {
  const d = repo();
  fs.writeFileSync(path.join(d, 'a.txt'), '1\n'); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'one');
  fs.writeFileSync(path.join(d, 'a.txt'), '2\n');
  assert.ok((await call('git:stash-push', d, 'wip', false)).ok);
  const list = await call('git:stash-list', d);
  assert.equal(list.stashes.length, 1);
  assert.match(list.stashes[0].subject, /wip/);
  assert.match((await call('git:stash-show', d, 0)).diff, /\+2/);
  assert.ok((await call('git:stash-pop', d, 0)).ok);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf-8'), '2\n');
  assert.equal((await call('git:stash-pop', d, 99)).ok, false);
  sh(d, 'checkout', '-qb', 'feat'); fs.writeFileSync(path.join(d, 'b.txt'), 'x\n'); sh(d, 'add', 'b.txt'); sh(d, 'commit', '-qm', 'feat');
  sh(d, 'checkout', '-q', 'main'); sh(d, 'checkout', '-q', '--', '.'); fs.writeFileSync(path.join(d, 'c.txt'), 'y\n'); sh(d, 'add', 'c.txt'); sh(d, 'commit', '-qm', 'main2');
  sh(d, 'merge', '-q', '--no-edit', 'feat');
  const g = await call('git:graph', d, 50);
  assert.ok(g.ok && g.rows.length === g.commits.length && g.commits.length >= 4);
  assert.ok(Math.max(...g.rows.map((r) => r.laneCount)) >= 2);
  const hist = await call('git:file-history', d, 'a.txt');
  assert.equal(hist.commits.length, 1);
});

test('rejects traversal and option-like input', async () => {
  const d = repo();
  assert.equal((await call('git:hunks', d, '../x', false)).ok, false);
  assert.equal((await call('git:commit-files', d, '--output=/tmp/x')).ok, false);
  assert.equal((await call('git:stash-drop', d, '-1')).ok, false);
});
