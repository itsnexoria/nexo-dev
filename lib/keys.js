'use strict';
// Pure keybinding helpers (UMD: loaded by node tests and bundled into the renderer).
(function (root) {
  const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];
  const ALIASES = { control: 'Ctrl', ctrl: 'Ctrl', cmd: 'Meta', command: 'Meta', meta: 'Meta', win: 'Meta', super: 'Meta', option: 'Alt', opt: 'Alt', alt: 'Alt', shift: 'Shift', cmdorctrl: 'CmdOrCtrl' };
  const KEY_ALIASES = { esc: 'Escape', escape: 'Escape', return: 'Enter', enter: 'Enter', space: 'Space', spacebar: 'Space', ' ': 'Space', del: 'Delete', delete: 'Delete', backspace: 'Backspace', tab: 'Tab',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
    home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert', plus: '+', minus: '-', comma: ',', period: '.', slash: '/', backslash: '\\', backtick: '`', grave: '`' };
  const MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta', 'altgraph', 'os']);

  function normKey(k) {
    if (k == null || k === '') return null;
    const lower = String(k).toLowerCase();
    if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
    if (String(k).length === 1) return String(k).toUpperCase();
    return null;
  }
  // "ctrl+shift+p" -> "Ctrl+Shift+P"; returns null for anything that is not a valid single chord.
  // isMac maps CmdOrCtrl; default keeps it as Ctrl.
  function normalizeChord(input, { isMac = false } = {}) {
    if (typeof input !== 'string') return null;
    const s = input.trim();
    if (!s || s.length > 40) return null;
    const parts = s.endsWith('++') ? [...s.slice(0, -2).split('+').filter(Boolean), '+'] : s.split('+').map((p) => p.trim()).filter((p, i, a) => p !== '' || i === a.length - 1);
    if (!parts.length) return null;
    const mods = new Set();
    let key = null;
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i];
      const a = ALIASES[raw.toLowerCase()];
      if (a && i < parts.length - 1) { mods.add(a === 'CmdOrCtrl' ? (isMac ? 'Meta' : 'Ctrl') : a); continue; }
      if (i !== parts.length - 1) return null;
      key = normKey(raw);
    }
    if (!key) return null;
    return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
  }
  // KeyboardEvent-like -> chord ('' while only a modifier is held)
  function chordFromEvent(e) {
    if (!e || MODIFIER_KEYS.has(String(e.key).toLowerCase())) return '';
    const key = normKey(e.key);
    if (!key) return '';
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl'); if (e.altKey) mods.push('Alt'); if (e.shiftKey) mods.push('Shift'); if (e.metaKey) mods.push('Meta');
    // Shift+= is '+', Shift+1 is '!': keep the physical-ish key by dropping Shift for printable symbols
    if (e.shiftKey && key.length === 1 && !/[A-Z]/.test(key) && !/[0-9]/.test(key)) mods.splice(mods.indexOf('Shift'), 1);
    return [...mods, key].join('+');
  }
  // A chord is usable as a global shortcut when it has a modifier or is a function key (plain letters belong to typing).
  function isGlobalChord(chord) {
    const c = normalizeChord(chord);
    if (!c) return false;
    return /^(Ctrl|Alt|Meta)\+/.test(c) || /(^|\+)F([1-9]|1[0-9]|2[0-4])$/.test(c);
  }
  // defaults/overrides: { id: chord|null }. Returns the effective { id: chord } (null = unbound).
  function effective(defaults, overrides) {
    const out = {};
    for (const [id, c] of Object.entries(defaults || {})) out[id] = normalizeChord(c);
    for (const [id, c] of Object.entries(overrides || {})) out[id] = c === null ? null : normalizeChord(c);
    return out;
  }
  // -> [{ chord, ids: [..] }] for chords bound to more than one command.
  function findConflicts(bindings) {
    const byChord = new Map();
    for (const [id, c] of Object.entries(bindings || {})) { if (!c) continue; if (!byChord.has(c)) byChord.set(c, []); byChord.get(c).push(id); }
    return [...byChord].filter(([, ids]) => ids.length > 1).map(([chord, ids]) => ({ chord, ids }));
  }
  // Sanitise a user overrides object (prefs / imported file).
  function sanitizeOverrides(obj, { max = 400 } = {}) {
    const out = {};
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
    for (const [id, v] of Object.entries(obj)) {
      if (Object.keys(out).length >= max) break;
      if (typeof id !== 'string' || !id || id.length > 200 || /[\u0000-\u001f]/.test(id)) continue;
      if (v === null) { out[id] = null; continue; }
      const c = normalizeChord(v);
      if (c) out[id] = c;
    }
    return out;
  }
  const api = { normalizeChord, chordFromEvent, isGlobalChord, effective, findConflicts, sanitizeOverrides, MODIFIER_KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NexoKeys = api;
})(typeof window !== 'undefined' ? window : globalThis);
