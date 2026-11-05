(function (root) {
  'use strict';
  // Export / import of custom theme presets ({ id, name, bg, text, accent }) as a shareable JSON file.
  const FORMAT = 'nexo-theme-presets';
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const MAX = 50;

  function serialize(presets) {
    const list = (Array.isArray(presets) ? presets : []).map((p) => ({ name: p.name, bg: p.bg, text: p.text, accent: p.accent }));
    return JSON.stringify({ format: FORMAT, version: 1, presets: list }, null, 2) + '\n';
  }

  // Returns validated presets with fresh ids; throws a readable Error on anything malformed.
  function parse(text, now = Date.now()) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Not a valid JSON file.'); }
    if (!data || data.format !== FORMAT || !Array.isArray(data.presets)) throw new Error('Not a Nexo theme preset file.');
    const out = [];
    for (const p of data.presets.slice(0, MAX)) {
      if (!p || typeof p.name !== 'string' || !p.name.trim()) continue;
      if (![p.bg, p.text, p.accent].every((c) => typeof c === 'string' && HEX.test(c))) continue;
      out.push({ id: `theme_${now}_${out.length}_${Math.random().toString(36).slice(2, 7)}`, name: p.name.trim().slice(0, 40), bg: p.bg.toLowerCase(), text: p.text.toLowerCase(), accent: p.accent.toLowerCase() });
    }
    if (!out.length) throw new Error('The file contains no valid presets.');
    return out;
  }

  const api = { serialize, parse, FORMAT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NexoThemePresets = api;
})(typeof window !== 'undefined' ? window : globalThis);
