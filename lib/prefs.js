// Preference defaults + sanitization for anything coming in over the
// prefs:set IPC channel. Pulled out of main.js on its own (same reasoning as
// the other lib/ modules) so the validation rules are unit-testable —
// malformed/malicious values here should always fall back to a safe
// default rather than being written to disk as-is.
'use strict';

const DEFAULT_PREFS = {
  theme: 'dark',
  fontSize: 13.5,
  minimap: true,
  wordWrap: false,
  bracketGuides: false,
  vimMode: false,
  formatOnSave: false,
  autoSave: false,
  autoSaveDelayMs: 1000,
  customShell: '',
  customTheme: { bg: '#0c0c10', text: '#ececf0', accent: '#ff3b30' },
  customThemes: [], // saved named presets: [{ id, name, bg, text, accent }]
  scriptsOrder: [],
  snippets: [], // [{ id, prefix, body, language }]
  discordRpcEnabled: false,
  discordClientId: '',
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function sanitizePrefsPartial(partial) {
  const clean = {};
  if (partial.theme !== undefined) {
    clean.theme = ['dark', 'light', 'midnight', 'contrast', 'custom'].includes(partial.theme) ? partial.theme : 'dark';
  }
  if (partial.fontSize !== undefined) {
    clean.fontSize = Math.max(9, Math.min(28, Number(partial.fontSize) || 13.5));
  }
  if (partial.minimap !== undefined) clean.minimap = !!partial.minimap;
  if (partial.wordWrap !== undefined) clean.wordWrap = !!partial.wordWrap;
  if (partial.bracketGuides !== undefined) clean.bracketGuides = !!partial.bracketGuides;
  if (partial.vimMode !== undefined) clean.vimMode = !!partial.vimMode;
  if (partial.formatOnSave !== undefined) clean.formatOnSave = !!partial.formatOnSave;
  if (partial.autoSave !== undefined) clean.autoSave = !!partial.autoSave;
  if (partial.autoSaveDelayMs !== undefined) {
    clean.autoSaveDelayMs = Math.max(200, Math.min(10000, Number(partial.autoSaveDelayMs) || 1000));
  }
  if (partial.customShell !== undefined) clean.customShell = String(partial.customShell).trim().slice(0, 500);
  if (partial.discordRpcEnabled !== undefined) clean.discordRpcEnabled = !!partial.discordRpcEnabled;
  if (partial.discordClientId !== undefined) clean.discordClientId = String(partial.discordClientId).trim().replace(/[^0-9]/g, '').slice(0, 20);
  if (partial.customTheme !== undefined && typeof partial.customTheme === 'object' && partial.customTheme) {
    const src = partial.customTheme;
    const def = DEFAULT_PREFS.customTheme;
    clean.customTheme = {
      bg: HEX_COLOR_RE.test(src.bg) ? src.bg : def.bg,
      text: HEX_COLOR_RE.test(src.text) ? src.text : def.text,
      accent: HEX_COLOR_RE.test(src.accent) ? src.accent : def.accent,
    };
  }
  if (partial.customThemes !== undefined && Array.isArray(partial.customThemes)) {
    clean.customThemes = partial.customThemes
      .filter((p) => p && typeof p === 'object')
      .slice(0, 30) // reasonable cap so this can't grow unbounded
      .map((p) => ({
        id: typeof p.id === 'string' && p.id ? p.id.slice(0, 100) : `theme_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 60) : 'Untitled theme',
        bg: HEX_COLOR_RE.test(p.bg) ? p.bg : DEFAULT_PREFS.customTheme.bg,
        text: HEX_COLOR_RE.test(p.text) ? p.text : DEFAULT_PREFS.customTheme.text,
        accent: HEX_COLOR_RE.test(p.accent) ? p.accent : DEFAULT_PREFS.customTheme.accent,
      }));
  }
  if (partial.scriptsOrder !== undefined && Array.isArray(partial.scriptsOrder)) {
    clean.scriptsOrder = partial.scriptsOrder
      .filter((s) => typeof s === 'string')
      .slice(0, 200)
      .map((s) => s.slice(0, 200));
  }
  if (partial.snippets !== undefined && Array.isArray(partial.snippets)) {
    clean.snippets = partial.snippets
      .filter((s) => s && typeof s === 'object')
      .slice(0, 300)
      .map((s) => ({
        id: typeof s.id === 'string' && s.id ? s.id.slice(0, 100) : `snip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        prefix: typeof s.prefix === 'string' ? s.prefix.trim().slice(0, 60) : '',
        body: typeof s.body === 'string' ? s.body.slice(0, 20000) : '',
        language: typeof s.language === 'string' && s.language ? s.language.slice(0, 40) : 'all',
        description: typeof s.description === 'string' ? s.description.slice(0, 200) : '',
      }))
      .filter((s) => s.prefix && s.body);
  }
  return clean;
}

module.exports = {
  DEFAULT_PREFS,
  HEX_COLOR_RE,
  sanitizePrefsPartial,
};
