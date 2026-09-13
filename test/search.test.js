'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  escapeRegExp,
  buildReplaceRegExp,
  walkForSearch,
  walkForReplace,
  walkForFileList,
  SEARCH_IGNORE_DIRS,
} = require('../lib/search');

function makeTempProject(structure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-search-'));
  for (const [relPath, content] of Object.entries(structure)) {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

// ---------- escapeRegExp ----------

test('escapeRegExp: escapes every regex special character', () => {
  const escaped = escapeRegExp('a.b*c?d[e]f(g)h{i}j|k^l$m\\n');
  const re = new RegExp(escaped);
  assert.ok(re.test('a.b*c?d[e]f(g)h{i}j|k^l$m\\n')); // matches the literal string...
  assert.ok(!re.test('aXbXcXdXfXhXjXkXlXm\\n')); // ...but not a version with the specials swapped for junk
});

// ---------- buildReplaceRegExp ----------

test('buildReplaceRegExp: plain-text mode treats the query literally', () => {
  const { re, safeReplacement } = buildReplaceRegExp('a.b', 'X', {});
  assert.equal('a.b and axb'.replace(re, safeReplacement), 'X and axb'); // "." must not act as a wildcard
});

test('buildReplaceRegExp: plain-text mode escapes "$" in the replacement', () => {
  const { re, safeReplacement } = buildReplaceRegExp('price', '$100', {});
  assert.equal('the price is set'.replace(re, safeReplacement), 'the $100 is set');
});

test('buildReplaceRegExp: regex mode honors capture-group references in the replacement', () => {
  const { re, safeReplacement } = buildReplaceRegExp('(\\w+)@(\\w+)', '$2@$1', { useRegex: true });
  assert.equal('user@host'.replace(re, safeReplacement), 'host@user');
});

test('buildReplaceRegExp: throws on an invalid regex so the caller can report it', () => {
  assert.throws(() => buildReplaceRegExp('(unclosed', 'x', { useRegex: true }));
});

test('buildReplaceRegExp: caseSensitive false matches regardless of case', () => {
  const { re, safeReplacement } = buildReplaceRegExp('Hello', 'Hi', { caseSensitive: false });
  assert.equal('hello world'.replace(re, safeReplacement), 'Hi world');
});

// ---------- walkForSearch ----------

test('walkForSearch: finds a plain-text match with correct line/column', async () => {
  const root = makeTempProject({ 'a.txt': 'nothing here\nfind me please\n' });
  const results = { matches: [], matchedFiles: 0 };
  await walkForSearch(root, 'find me', false, results, false);
  assert.equal(results.matches.length, 1);
  assert.equal(results.matches[0].matches[0].line, 2);
  assert.equal(results.matches[0].matches[0].col, 1);
});

test('walkForSearch: case-insensitive by default, case-sensitive on request', async () => {
  const root = makeTempProject({ 'a.txt': 'Hello World\n' });
  const caseInsensitive = { matches: [], matchedFiles: 0 };
  await walkForSearch(root, 'hello', false, caseInsensitive, false);
  assert.equal(caseInsensitive.matches.length, 1);

  const caseSensitive = { matches: [], matchedFiles: 0 };
  await walkForSearch(root, 'hello', true, caseSensitive, false);
  assert.equal(caseSensitive.matches.length, 0);
});

test('walkForSearch: regex mode finds matches across multiple files', async () => {
  const root = makeTempProject({
    'a.js': 'const x = 1;\nfunction foo() {}\n',
    'b.js': 'function bar() {}\n',
    'c.txt': 'function is just a word here, no call syntax\n',
  });
  const results = { matches: [], matchedFiles: 0 };
  await walkForSearch(root, 'function \\w+\\(', false, results, true);
  assert.equal(results.matchedFiles, 2); // c.txt has the word "function" but no "name(" call syntax, so it shouldn't match
});

test('walkForSearch: skips ignored directories entirely', async () => {
  const root = makeTempProject({
    'node_modules/dep/index.js': 'findme findme findme',
    'src/index.js': 'findme',
  });
  const results = { matches: [], matchedFiles: 0 };
  await walkForSearch(root, 'findme', false, results, false);
  assert.equal(results.matchedFiles, 1);
  assert.ok(results.matches[0].path.includes('src'));
});

test('walkForSearch: skips dotfiles/dot-directories', async () => {
  const root = makeTempProject({
    '.hidden/secret.txt': 'findme',
    'visible.txt': 'findme',
  });
  const results = { matches: [], matchedFiles: 0 };
  await walkForSearch(root, 'findme', false, results, false);
  assert.equal(results.matchedFiles, 1);
  assert.ok(results.matches[0].path.includes('visible.txt'));
});

test('walkForSearch: skips known binary extensions even if content happens to be text-like', async () => {
  const root = makeTempProject({ 'image.png': 'findme' });
  const results = { matches: [], matchedFiles: 0 };
  await walkForSearch(root, 'findme', false, results, false);
  assert.equal(results.matchedFiles, 0);
});

test('walkForSearch: skips files containing a NUL byte (binary heuristic)', async () => {
  const root = makeTempProject({});
  fs.writeFileSync(path.join(root, 'weird.dat'), Buffer.from('findme\0more'));
  const results = { matches: [], matchedFiles: 0 };
  await walkForSearch(root, 'findme', false, results, false);
  assert.equal(results.matchedFiles, 0);
});

test('walkForSearch: an invalid regex query is a no-op rather than throwing', async () => {
  const root = makeTempProject({ 'a.txt': 'anything\n' });
  const results = { matches: [], matchedFiles: 0 };
  await assert.doesNotReject(walkForSearch(root, '(unclosed', false, results, true));
  assert.equal(results.matches.length, 0);
});

// ---------- walkForReplace ----------

test('walkForReplace: rewrites matching files and reports counts', async () => {
  const root = makeTempProject({
    'a.txt': 'foo foo foo\n',
    'b.txt': 'bar\n',
  });
  const { re, safeReplacement } = buildReplaceRegExp('foo', 'baz', {});
  const results = { filesChanged: 0, totalReplacements: 0, changedPaths: [], errors: [] };
  await walkForReplace(root, re, safeReplacement, results);
  assert.equal(results.filesChanged, 1);
  assert.equal(results.totalReplacements, 3);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf-8'), 'baz baz baz\n');
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf-8'), 'bar\n'); // untouched
});

test('walkForReplace: calls the onFileWritten callback for each changed file', async () => {
  const root = makeTempProject({ 'a.txt': 'foo\n', 'b.txt': 'foo\n' });
  const { re, safeReplacement } = buildReplaceRegExp('foo', 'bar', {});
  const results = { filesChanged: 0, totalReplacements: 0, changedPaths: [], errors: [] };
  const written = [];
  await walkForReplace(root, re, safeReplacement, results, (p) => written.push(p));
  assert.equal(written.length, 2);
});

test('walkForReplace: leaves files with no match completely untouched', async () => {
  const root = makeTempProject({ 'a.txt': 'nothing to see\n' });
  const before = fs.statSync(path.join(root, 'a.txt')).mtimeMs;
  const { re, safeReplacement } = buildReplaceRegExp('missing', 'x', {});
  const results = { filesChanged: 0, totalReplacements: 0, changedPaths: [], errors: [] };
  await walkForReplace(root, re, safeReplacement, results);
  assert.equal(results.filesChanged, 0);
  assert.equal(fs.statSync(path.join(root, 'a.txt')).mtimeMs, before);
});

// ---------- walkForFileList ----------

test('walkForFileList: lists files recursively, excluding ignored directories', async () => {
  const root = makeTempProject({
    'src/a.js': '',
    'src/nested/b.js': '',
    'node_modules/dep/index.js': '',
    '.git/HEAD': '',
  });
  const out = [];
  await walkForFileList(root, out);
  const relative = out.map((p) => path.relative(root, p).split(path.sep).join('/')).sort();
  assert.deepEqual(relative, ['src/a.js', 'src/nested/b.js']);
});

test('SEARCH_IGNORE_DIRS: contains the expected common noise directories', () => {
  for (const dir of ['node_modules', '.git', 'dist', 'build']) {
    assert.ok(SEARCH_IGNORE_DIRS.has(dir));
  }
});
