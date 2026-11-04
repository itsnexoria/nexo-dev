'use strict';
// Pure helpers for hunk / line level staging. A unified diff of ONE file is parsed into
// { header, hunks }, and a (possibly partial) selection is turned back into a patch that
// `git apply --cached [-R]` accepts. No Electron / git dependency, so it is unit-testable.

// Parse a single-file unified diff. Lines of a hunk are { t: ' ' | '+' | '-' | '\\', s: text }.
function parseDiff(text) {
  const out = { header: [], hunks: [], binary: false };
  if (!text) return out;
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let cur = null;
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (m) {
      cur = {
        oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4],
        section: m[5] || '', lines: [],
      };
      out.hunks.push(cur);
      continue;
    }
    if (!cur) {
      if (/^(Binary files|GIT binary patch)/.test(line)) out.binary = true;
      out.header.push(line);
      continue;
    }
    const c = line[0];
    if (c === ' ' || c === '+' || c === '-' || c === '\\') cur.lines.push({ t: c, s: line.slice(1) });
    else if (line === '') cur.lines.push({ t: ' ', s: '' }); // some tools strip the leading space of blank context lines
    else if (/^diff --git /.test(line)) break; // second file: not supported, ignore the rest
  }
  return out;
}

const hunkHeader = (h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section || ''}`;

// selection: array of { hunk: index, lines?: [indexes into hunk.lines] }.
// A missing `lines` selects the whole hunk. `reverse` is true when the patch will be applied
// with -R (unstage / discard): then unselected '+' lines become context and unselected '-' are dropped.
// Returns the patch text, or null when nothing selected changes anything.
function buildPatch(parsed, selection, { reverse = false } = {}) {
  const sel = new Map();
  for (const s of selection || []) {
    if (!s || !Number.isInteger(s.hunk) || s.hunk < 0 || s.hunk >= parsed.hunks.length) continue;
    if (s.lines === undefined || s.lines === null) sel.set(s.hunk, null);
    else if (Array.isArray(s.lines)) {
      const prev = sel.get(s.hunk);
      if (prev === null) continue;
      const set = prev || new Set();
      for (const i of s.lines) if (Number.isInteger(i)) set.add(i);
      sel.set(s.hunk, set);
    }
  }
  const body = [];
  let delta = 0; // newStart shift caused by earlier hunks being only partially applied
  for (const idx of [...sel.keys()].sort((a, b) => a - b)) {
    const h = parsed.hunks[idx];
    const picked = sel.get(idx);
    const outLines = [];
    let keptOld = 0, keptNew = 0, changes = 0;
    for (let i = 0; i < h.lines.length; i++) {
      const l = h.lines[i];
      if (l.t === '\\') { // "\ No newline at end of file" follows the previous line; keep only if that was kept
        if (outLines.length && outLines.prevKept === i - 1) outLines.push(l);
        continue;
      }
      const isSelected = picked === null || picked.has(i);
      let t = l.t;
      if (t === '+' || t === '-') {
        if (isSelected) changes++;
        else if (t === (reverse ? '-' : '+')) { continue; } // drop the unselected change
        else t = ' ';                                       // keep the unselected change as context
      }
      outLines.push({ t, s: l.s });
      outLines.prevKept = i;
      if (t === ' ' || t === '-') keptOld++;
      if (t === ' ' || t === '+') keptNew++;
    }
    if (!changes) continue;
    const hh = { oldStart: h.oldStart, oldLines: keptOld, newStart: h.oldStart + delta, newLines: keptNew, section: h.section };
    if (hh.oldLines === 0) hh.oldStart = Math.max(0, h.oldStart); // pure insertion at top: git wants start of "line before"
    if (hh.newLines === 0) hh.newStart = Math.max(0, hh.newStart);
    delta += keptNew - keptOld;
    body.push(hunkHeader(hh));
    for (const l of outLines) body.push(l.t + l.s);
  }
  if (!body.length) return null;
  return parsed.header.concat(body).join('\n') + '\n';
}

// Whole-file shortcuts
const allHunks = (parsed) => parsed.hunks.map((_, i) => ({ hunk: i }));

module.exports = { parseDiff, buildPatch, allHunks, hunkHeader };
