const test = require('node:test');
const assert = require('node:assert');
const K = require('../lib/keys');

test('normalizeChord canonicalises modifiers, order and aliases', () => {
  assert.equal(K.normalizeChord('ctrl+shift+p'), 'Ctrl+Shift+P');
  assert.equal(K.normalizeChord('Shift+Ctrl+P'), 'Ctrl+Shift+P');
  assert.equal(K.normalizeChord('cmd+s'), 'Meta+S');
  assert.equal(K.normalizeChord('CmdOrCtrl+S'), 'Ctrl+S');
  assert.equal(K.normalizeChord('CmdOrCtrl+S', { isMac: true }), 'Meta+S');
  assert.equal(K.normalizeChord('f5'), 'F5');
  assert.equal(K.normalizeChord('ctrl+esc'), 'Ctrl+Escape');
  assert.equal(K.normalizeChord('Ctrl++'), 'Ctrl++');
  assert.equal(K.normalizeChord('Ctrl+`'), 'Ctrl+`');
  assert.equal(K.normalizeChord('Ctrl+\\'), 'Ctrl+\\');
});
test('normalizeChord rejects junk', () => {
  for (const bad of ['', 'Ctrl+', 'Ctrl+Shift', 'Foo+P', 'a+b', 'Ctrl+Ctrl', null, 42, 'x'.repeat(50)]) assert.equal(K.normalizeChord(bad), null, String(bad));
});
test('chordFromEvent', () => {
  assert.equal(K.chordFromEvent({ key: 'p', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+P');
  assert.equal(K.chordFromEvent({ key: 'Control', ctrlKey: true }), '');
  assert.equal(K.chordFromEvent({ key: '+', ctrlKey: true, shiftKey: true }), 'Ctrl++');
  assert.equal(K.chordFromEvent({ key: 'F5' }), 'F5');
  assert.equal(K.chordFromEvent({ key: ' ', ctrlKey: true }), 'Ctrl+Space');
});
test('isGlobalChord requires a modifier or an F key', () => {
  assert.ok(K.isGlobalChord('Ctrl+K')); assert.ok(K.isGlobalChord('F12')); assert.ok(K.isGlobalChord('Alt+Left'));
  assert.ok(!K.isGlobalChord('K')); assert.ok(!K.isGlobalChord('Shift+K')); assert.ok(!K.isGlobalChord('nonsense'));
});
test('effective + conflicts', () => {
  const eff = K.effective({ a: 'Ctrl+S', b: 'Ctrl+O', c: 'F5' }, { b: 'ctrl+s', c: null });
  assert.deepEqual(eff, { a: 'Ctrl+S', b: 'Ctrl+S', c: null });
  assert.deepEqual(K.findConflicts(eff), [{ chord: 'Ctrl+S', ids: ['a', 'b'] }]);
});
test('sanitizeOverrides drops bad entries, keeps null (explicit unbind)', () => {
  const out = K.sanitizeOverrides({ ok: 'cmd+k', off: null, bad: 'zzz', '': 'Ctrl+A', ['x'.repeat(300)]: 'Ctrl+B', ctl: 'Ctrl+Q' });
  assert.deepEqual(out, { ok: 'Meta+K', off: null, ctl: 'Ctrl+Q' });
  assert.deepEqual(K.sanitizeOverrides([1, 2]), {});
  assert.deepEqual(K.sanitizeOverrides('x'), {});
});
