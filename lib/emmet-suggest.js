(function (root) {
  'use strict';
  // Pure Emmet suggestion logic (the emmet package is injected, so this is unit-testable and bundle-free).
  const MARKUP = new Set(['html', 'xml']);
  const STYLE = new Set(['css', 'scss', 'less']);
  const supports = (lang) => MARKUP.has(lang) || STYLE.has(lang);

  // line: text of the current line; col: 0-based cursor offset in it.
  // Returns { abbr, start, end, text } (start/end are 0-based offsets in `line`) or null.
  function suggest(emmet, lang, line, col) {
    if (!emmet || !supports(lang)) return null;
    const type = MARKUP.has(lang) ? 'markup' : 'stylesheet';
    const found = emmet.extract(line, col, { type, lookAhead: false });
    if (!found || !found.abbreviation) return null;
    let text;
    try { text = emmet.expand(found.abbreviation, { type, syntax: MARKUP.has(lang) ? 'html' : lang }); } catch { return null; }
    if (!text || text === found.abbreviation) return null;
    return { abbr: found.abbreviation, start: found.start, end: found.end, text };
  }

  const api = { suggest, supports };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NexoEmmetSuggest = api;
})(typeof window !== 'undefined' ? window : globalThis);
