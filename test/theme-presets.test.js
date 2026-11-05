const test = require('node:test');
const assert = require('node:assert');
const { serialize, parse } = require('../lib/theme-presets');

const preset = { id: 'x', name: 'Ocean', bg: '#001122', text: '#ffffff', accent: '#00AAFF' };
test('round-trips presets with fresh ids', () => {
  const out = parse(serialize([preset]));
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual({ ...out[0], id: '' }, { id: '', name: 'Ocean', bg: '#001122', text: '#ffffff', accent: '#00aaff' });
  assert.notStrictEqual(out[0].id, 'x');
});
test('skips invalid entries but keeps valid ones', () => {
  const text = JSON.stringify({ format: 'nexo-theme-presets', version: 1, presets: [{ name: 'bad', bg: 'red', text: '#fff', accent: '#000' }, { name: ' ', bg: '#000000', text: '#ffffff', accent: '#111111' }, preset] });
  assert.deepStrictEqual(parse(text).map((p) => p.name), ['Ocean']);
});
test('rejects wrong format, bad JSON and empty files', () => {
  assert.throws(() => parse('nope'), /valid JSON/);
  assert.throws(() => parse('{"presets":[]}'), /Nexo theme preset/);
  assert.throws(() => parse(serialize([])), /no valid presets/);
});
test('caps preset count and name length', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ name: 'n'.repeat(100) + i, bg: '#000000', text: '#ffffff', accent: '#111111' }));
  const out = parse(serialize(many));
  assert.strictEqual(out.length, 50);
  assert.ok(out.every((p) => p.name.length <= 40));
  assert.strictEqual(new Set(out.map((p) => p.id)).size, 50);
});
