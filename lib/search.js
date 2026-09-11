// Global text search, project-wide replace, and the flat file list used by
// Quick Open — all pulled out of main.js on their own (same reasoning as
// lib/editorconfig.js) so they can be unit-tested with plain Node. None of
// this touches Electron; it's fs/path only.
'use strict';

const fs = require('fs');
const path = require('path');

const SEARCH_IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'out', 'coverage']);
const SEARCH_SKIP_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg', 'pdf', 'zip', 'gz', 'tar', 'rar', '7z',
  'exe', 'dll', 'so', 'dylib', 'woff', 'woff2', 'ttf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'mkv',
  'lock', 'ico', 'db', 'sqlite',
]);
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024; // skip anything bigger than 2MB
const SEARCH_MAX_MATCHES = 500;
const SEARCH_MAX_FILES_WITH_MATCHES = 200;
const QUICK_OPEN_MAX_FILES = 5000;
const MAX_MATCHES_PER_FILE = 30;

// Recursive directory walkers below (walkForSearch, walkForReplace,
// walkForFileList) are all `async` and call this between entries so a big
// project (thousands of files) doesn't freeze the whole app for the duration
// of the walk — without it, these were synchronous top-to-bottom and blocked
// the main process's event loop, which stalls every window's IPC, not just
// the one that triggered the search.
let __walkYieldCounter = 0;
function maybeYieldToEventLoop() {
  __walkYieldCounter++;
  if (__walkYieldCounter % 150 !== 0) return null;
  return new Promise((resolve) => setImmediate(resolve));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Builds the RegExp + a replacement string that's safe to pass to
// String.prototype.replace, given the search:replace-all options. Throws if
// opts.useRegex is set and query isn't a valid pattern — callers should wrap
// this in a try/catch to turn that into a friendly error.
function buildReplaceRegExp(query, replacement, opts = {}) {
  if (opts.useRegex) {
    const re = new RegExp(query, opts.caseSensitive ? 'g' : 'gi');
    // Regex mode: $1, $2, etc. are honored as capture-group references.
    return { re, safeReplacement: String(replacement) };
  }
  const re = new RegExp(escapeRegExp(query), opts.caseSensitive ? 'g' : 'gi');
  // Escape $ in the replacement so String.replace doesn't treat it as a
  // special pattern ($&, $1, etc.) — this is a literal find & replace, not
  // a regex-capture-group replace.
  const safeReplacement = String(replacement).replace(/\$/g, '$$$$');
  return { re, safeReplacement };
}

async function walkForSearch(root, query, caseSensitive, results, useRegex) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  let lineRe = null;
  if (useRegex) {
    try { lineRe = new RegExp(query, caseSensitive ? 'g' : 'gi'); } catch { return; }
  }
  for (const entry of entries) {
    if (results.matchedFiles >= SEARCH_MAX_FILES_WITH_MATCHES || results.matches.length >= SEARCH_MAX_MATCHES) return;
    await maybeYieldToEventLoop();
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SEARCH_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walkForSearch(full, query, caseSensitive, results, useRegex);
      continue;
    }
    const ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
    if (SEARCH_SKIP_EXT.has(ext)) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
    let content;
    try {
      content = fs.readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    // crude binary check
    if (content.includes('\u0000')) continue;

    if (useRegex) {
      lineRe.lastIndex = 0;
      if (!lineRe.test(content)) continue;
    } else {
      const haystack = caseSensitive ? content : content.toLowerCase();
      const needle = caseSensitive ? query : query.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }

    const lines = content.split(/\r\n|\r|\n/);
    const fileMatches = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (useRegex) {
        lineRe.lastIndex = 0;
        let m = lineRe.exec(line);
        while (m) {
          fileMatches.push({ line: i + 1, col: m.index + 1, preview: line.trim().slice(0, 200) });
          if (fileMatches.length >= MAX_MATCHES_PER_FILE) break;
          if (m[0].length === 0) lineRe.lastIndex++; // avoid infinite loop on zero-width matches
          m = lineRe.exec(line);
        }
      } else {
        const hLine = caseSensitive ? line : line.toLowerCase();
        const needle = caseSensitive ? query : query.toLowerCase();
        let idx = hLine.indexOf(needle);
        while (idx !== -1) {
          fileMatches.push({ line: i + 1, col: idx + 1, preview: line.trim().slice(0, 200) });
          if (fileMatches.length >= MAX_MATCHES_PER_FILE) break;
          idx = hLine.indexOf(needle, idx + needle.length);
        }
      }
      if (fileMatches.length >= MAX_MATCHES_PER_FILE) break;
    }
    if (fileMatches.length) {
      results.matches.push({ path: full, matches: fileMatches });
      results.matchedFiles++;
    }
  }
}

// onFileWritten(path) is called after each successful replacement write —
// main.js uses this to feed its own-write guard (recentWrites) so the file
// watcher doesn't mistake the app's own edit for an external change. Callers
// that don't need that (e.g. tests) can omit it.
async function walkForReplace(root, re, replacement, results, onFileWritten = () => {}) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.filesChanged >= SEARCH_MAX_FILES_WITH_MATCHES) return;
    await maybeYieldToEventLoop();
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SEARCH_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walkForReplace(full, re, replacement, results, onFileWritten);
      continue;
    }
    const ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
    if (SEARCH_SKIP_EXT.has(ext)) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
    let content;
    try {
      content = fs.readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue;

    re.lastIndex = 0;
    const matches = content.match(re);
    if (!matches || !matches.length) continue;

    try {
      const updated = content.replace(re, replacement);
      fs.writeFileSync(full, updated, 'utf-8');
      onFileWritten(full);
      results.filesChanged++;
      results.totalReplacements += matches.length;
      results.changedPaths.push(full);
    } catch (err) {
      results.errors.push({ path: full, error: err.message });
    }
  }
}

// Flat recursive file list (paths only) for Quick Open — reuses the same
// ignore rules as global search so it skips node_modules/.git/build output.
async function walkForFileList(root, out) {
  if (out.length >= QUICK_OPEN_MAX_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= QUICK_OPEN_MAX_FILES) return;
    await maybeYieldToEventLoop();
    if (entry.isDirectory()) {
      if (SEARCH_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walkForFileList(path.join(root, entry.name), out);
      continue;
    }
    out.push(path.join(root, entry.name));
  }
}

module.exports = {
  SEARCH_IGNORE_DIRS,
  SEARCH_SKIP_EXT,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_MATCHES,
  SEARCH_MAX_FILES_WITH_MATCHES,
  QUICK_OPEN_MAX_FILES,
  escapeRegExp,
  buildReplaceRegExp,
  walkForSearch,
  walkForReplace,
  walkForFileList,
};
