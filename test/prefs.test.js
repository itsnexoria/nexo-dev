'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_PREFS, HEX_COLOR_RE, sanitizePrefsPartial } = require('../lib/prefs');

// ---------- basic pass-through of valid values ----------

test('sanitizePrefsPartial: accepts a valid theme', () => {
  assert.equal(sanitizePrefsPartial({ theme: 'midnight' }).theme, 'midnight');
});

test('sanitizePrefsPartial: rejects an unknown theme, falling back to dark', () => {
  assert.equal(sanitizePrefsPartial({ theme: 'not-a-real-theme' }).theme, 'dark');
});

test('sanitizePrefsPartial: omits keys that were not part of the partial', () => {
  const clean = sanitizePrefsPartial({ theme: 'light' });
  assert.ok('theme' in clean);
  assert.ok(!('fontSize' in clean)); // untouched keys aren't invented
});

// ---------- fontSize clamping ----------

test('sanitizePrefsPartial: fontSize is clamped to the 9-28 range', () => {
  assert.equal(sanitizePrefsPartial({ fontSize: 100 }).fontSize, 28);
  assert.equal(sanitizePrefsPartial({ fontSize: 1 }).fontSize, 9);
  assert.equal(sanitizePrefsPartial({ fontSize: 16 }).fontSize, 16);
});

test('sanitizePrefsPartial: a non-numeric fontSize falls back to the default', () => {
  assert.equal(sanitizePrefsPartial({ fontSize: 'huge' }).fontSize, 13.5);
});

// ---------- booleans coerced regardless of input type ----------

test('sanitizePrefsPartial: boolean-ish prefs are coerced to real booleans', () => {
  const clean = sanitizePrefsPartial({ minimap: 'yes', wordWrap: 0, vimMode: 1 });
  assert.equal(clean.minimap, true);
  assert.equal(clean.wordWrap, false);
  assert.equal(clean.vimMode, true);
});

// ---------- autoSaveDelayMs clamping ----------

test('sanitizePrefsPartial: autoSaveDelayMs is clamped to 200-10000', () => {
  assert.equal(sanitizePrefsPartial({ autoSaveDelayMs: 50 }).autoSaveDelayMs, 200);
  assert.equal(sanitizePrefsPartial({ autoSaveDelayMs: 999999 }).autoSaveDelayMs, 10000);
});

// ---------- customShell length cap ----------

test('sanitizePrefsPartial: customShell is trimmed and capped at 500 chars', () => {
  assert.equal(sanitizePrefsPartial({ customShell: '  pwsh  ' }).customShell, 'pwsh');
  assert.equal(sanitizePrefsPartial({ customShell: 'x'.repeat(600) }).customShell.length, 500);
});

// ---------- customTheme validation ----------

test('sanitizePrefsPartial: valid hex colors pass through in customTheme', () => {
  const clean = sanitizePrefsPartial({ customTheme: { bg: '#111111', text: '#eeeeee', accent: '#ff0000' } });
  assert.deepEqual(clean.customTheme, { bg: '#111111', text: '#eeeeee', accent: '#ff0000' });
});

test('sanitizePrefsPartial: invalid hex colors in customTheme fall back to defaults per-field', () => {
  const clean = sanitizePrefsPartial({ customTheme: { bg: 'not-a-color', text: '#eeeeee', accent: 'javascript:alert(1)' } });
  assert.equal(clean.customTheme.bg, DEFAULT_PREFS.customTheme.bg); // rejected, falls back
  assert.equal(clean.customTheme.text, '#eeeeee'); // valid, kept
  assert.equal(clean.customTheme.accent, DEFAULT_PREFS.customTheme.accent); // rejected, falls back
});

test('sanitizePrefsPartial: a non-object customTheme is ignored entirely', () => {
  const clean = sanitizePrefsPartial({ customTheme: 'not an object' });
  assert.ok(!('customTheme' in clean));
});

// ---------- customThemes array ----------

test('sanitizePrefsPartial: customThemes filters non-objects and caps at 30 entries', () => {
  const themes = Array.from({ length: 40 }, (_, i) => ({ name: `Theme ${i}`, bg: '#000000', text: '#ffffff', accent: '#ff0000' }));
  const clean = sanitizePrefsPartial({ customThemes: [...themes, null, 'garbage', 42] });
  assert.equal(clean.customThemes.length, 30);
});

test('sanitizePrefsPartial: customThemes assigns a fallback id/name when missing', () => {
  const clean = sanitizePrefsPartial({ customThemes: [{ bg: '#000000', text: '#ffffff', accent: '#ff0000' }] });
  assert.ok(clean.customThemes[0].id);
  assert.equal(clean.customThemes[0].name, 'Untitled theme');
});

test('sanitizePrefsPartial: customThemes name/id length are capped', () => {
  const clean = sanitizePrefsPartial({
    customThemes: [{ id: 'x'.repeat(200), name: 'y'.repeat(200), bg: '#000000', text: '#ffffff', accent: '#ff0000' }],
  });
  assert.equal(clean.customThemes[0].id.length, 100);
  assert.equal(clean.customThemes[0].name.length, 60);
});

// ---------- snippets array ----------

test('sanitizePrefsPartial: snippets missing a prefix or body are dropped', () => {
  const clean = sanitizePrefsPartial({
    snippets: [
      { prefix: 'log', body: 'console.log()' }, // valid
      { prefix: '', body: 'console.log()' }, // no prefix — dropped
      { prefix: 'log2', body: '' }, // no body — dropped
    ],
  });
  assert.equal(clean.snippets.length, 1);
  assert.equal(clean.snippets[0].prefix, 'log');
});

test('sanitizePrefsPartial: snippet body is capped at 20000 chars, prefix at 60', () => {
  const clean = sanitizePrefsPartial({
    snippets: [{ prefix: 'x'.repeat(100), body: 'y'.repeat(30000) }],
  });
  assert.equal(clean.snippets[0].prefix.length, 60);
  assert.equal(clean.snippets[0].body.length, 20000);
});

test('sanitizePrefsPartial: snippet language defaults to "all" when missing', () => {
  const clean = sanitizePrefsPartial({ snippets: [{ prefix: 'x', body: 'y' }] });
  assert.equal(clean.snippets[0].language, 'all');
});

// ---------- scriptsOrder ----------

test('sanitizePrefsPartial: scriptsOrder filters non-strings and caps length', () => {
  const clean = sanitizePrefsPartial({ scriptsOrder: ['build', 42, null, 'test'] });
  assert.deepEqual(clean.scriptsOrder, ['build', 'test']);
});

// ---------- Discord Rich Presence prefs ----------

test('sanitizePrefsPartial: discordRpcEnabled is coerced to a real boolean', () => {
  assert.equal(sanitizePrefsPartial({ discordRpcEnabled: 'yes' }).discordRpcEnabled, true);
  assert.equal(sanitizePrefsPartial({ discordRpcEnabled: 0 }).discordRpcEnabled, false);
});

test('sanitizePrefsPartial: discordClientId strips non-digit characters', () => {
  assert.equal(sanitizePrefsPartial({ discordClientId: '123abc456' }).discordClientId, '123456');
  assert.equal(sanitizePrefsPartial({ discordClientId: '  987654321  ' }).discordClientId, '987654321');
});

test('sanitizePrefsPartial: discordClientId is capped at 20 characters', () => {
  const clean = sanitizePrefsPartial({ discordClientId: '1'.repeat(40) });
  assert.equal(clean.discordClientId.length, 20);
});

test('sanitizePrefsPartial: a discordClientId with no digits at all sanitizes to an empty string', () => {
  assert.equal(sanitizePrefsPartial({ discordClientId: 'not-a-real-id!!' }).discordClientId, '');
});

// ---------- HEX_COLOR_RE sanity ----------

test('HEX_COLOR_RE: accepts 6-digit hex, rejects everything else', () => {
  assert.ok(HEX_COLOR_RE.test('#abc123'));
  assert.ok(!HEX_COLOR_RE.test('#abc')); // 3-digit shorthand not supported
  assert.ok(!HEX_COLOR_RE.test('red'));
  assert.ok(!HEX_COLOR_RE.test('javascript:alert(1)'));
});
