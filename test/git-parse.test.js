'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePorcelainStatus, parseBlamePorcelain, parseGithubOwnerRepo } = require('../lib/git-parse');

// ---------- parsePorcelainStatus ----------

test('parsePorcelainStatus: staged modification', () => {
  const { staged, unstaged, conflicts } = parsePorcelainStatus('M  a.js\n');
  assert.deepEqual(staged, [{ path: 'a.js', status: 'M', label: 'Modified', renamedFrom: null }]);
  assert.equal(unstaged.length, 0);
  assert.equal(conflicts.length, 0);
});

test('parsePorcelainStatus: unstaged modification', () => {
  const { staged, unstaged } = parsePorcelainStatus(' M a.js\n');
  assert.equal(staged.length, 0);
  assert.deepEqual(unstaged, [{ path: 'a.js', status: 'M', label: 'Modified', renamedFrom: null }]);
});

test('parsePorcelainStatus: a file both staged and further modified appears in both lists', () => {
  const { staged, unstaged } = parsePorcelainStatus('MM a.js\n');
  assert.equal(staged.length, 1);
  assert.equal(staged[0].label, 'Modified');
  assert.equal(unstaged.length, 1);
  assert.equal(unstaged[0].label, 'Modified');
});

test('parsePorcelainStatus: untracked file', () => {
  const { unstaged } = parsePorcelainStatus('?? new-file.txt\n');
  assert.deepEqual(unstaged, [{ path: 'new-file.txt', status: '?', label: 'Untracked', renamedFrom: null }]);
});

test('parsePorcelainStatus: renamed file records renamedFrom and the new path', () => {
  const { staged } = parsePorcelainStatus('R  old-name.js -> new-name.js\n');
  assert.equal(staged[0].path, 'new-name.js');
  assert.equal(staged[0].renamedFrom, 'old-name.js');
  assert.equal(staged[0].label, 'Renamed');
});

test('parsePorcelainStatus: merge conflict codes are separated into their own list', () => {
  const { conflicts, staged, unstaged } = parsePorcelainStatus('UU conflicted.js\n');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'conflicted.js');
  assert.equal(conflicts[0].code, 'UU');
  assert.equal(staged.length, 0);
  assert.equal(unstaged.length, 0);
});

test('parsePorcelainStatus: added and deleted files get the right labels', () => {
  const { staged } = parsePorcelainStatus('A  added.js\nD  deleted.js\n');
  assert.equal(staged[0].label, 'Added');
  assert.equal(staged[1].label, 'Deleted');
});

test('parsePorcelainStatus: multiple files across categories in one call', () => {
  const output = ['M  staged.js', ' M unstaged.js', '?? untracked.js', 'UU conflict.js', ''].join('\n');
  const { staged, unstaged, conflicts } = parsePorcelainStatus(output);
  assert.equal(staged.length, 1);
  assert.equal(unstaged.length, 2); // untracked.js counts as unstaged too
  assert.equal(conflicts.length, 1);
});

test('parsePorcelainStatus: empty output yields empty everything', () => {
  const { staged, unstaged, conflicts } = parsePorcelainStatus('');
  assert.deepEqual(staged, []);
  assert.deepEqual(unstaged, []);
  assert.deepEqual(conflicts, []);
});

// ---------- parseBlamePorcelain ----------

test('parseBlamePorcelain: single commit, single line', () => {
  const hash = 'a'.repeat(40);
  const output = [
    `${hash} 1 1 1`,
    'author Jane Doe',
    'author-time 1700000000',
    'summary Initial commit',
    '\tconsole.log("hi");',
    '',
  ].join('\n');
  const result = parseBlamePorcelain(output);
  assert.equal(result[1].hash, hash);
  assert.equal(result[1].author, 'Jane Doe');
  assert.equal(result[1].time, 1700000000);
  assert.equal(result[1].summary, 'Initial commit');
});

test('parseBlamePorcelain: a repeated commit only shows full metadata once, but every line resolves', () => {
  const hash = 'b'.repeat(40);
  const output = [
    `${hash} 1 1 3`,
    'author Jane Doe',
    'author-time 1700000000',
    'summary Add feature',
    '\tline one',
    `${hash} 2 2`, // subsequent occurrence — no metadata lines, straight to the tab line
    '\tline two',
    `${hash} 3 3`,
    '\tline three',
    '',
  ].join('\n');
  const result = parseBlamePorcelain(output);
  assert.equal(Object.keys(result).length, 3);
  assert.equal(result[1].author, 'Jane Doe');
  assert.equal(result[2].author, 'Jane Doe'); // reused from the cache, not re-parsed from blank metadata
  assert.equal(result[3].author, 'Jane Doe');
});

test('parseBlamePorcelain: multiple distinct commits', () => {
  const hashA = 'c'.repeat(40);
  const hashB = 'd'.repeat(40);
  const output = [
    `${hashA} 1 1 2`,
    'author Alice',
    'author-time 1000',
    'summary A',
    '\tfirst',
    `${hashB} 1 2`,
    'author Bob',
    'author-time 2000',
    'summary B',
    '\tsecond',
    '',
  ].join('\n');
  const result = parseBlamePorcelain(output);
  assert.equal(result[1].author, 'Alice');
  assert.equal(result[2].author, 'Bob');
});

test('parseBlamePorcelain: empty output returns an empty object', () => {
  assert.deepEqual(parseBlamePorcelain(''), {});
});

// ---------- parseGithubOwnerRepo ----------

test('parseGithubOwnerRepo: https URL with .git suffix', () => {
  assert.deepEqual(parseGithubOwnerRepo('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo' });
});

test('parseGithubOwnerRepo: https URL without .git suffix', () => {
  assert.deepEqual(parseGithubOwnerRepo('https://github.com/owner/repo'), { owner: 'owner', repo: 'repo' });
});

test('parseGithubOwnerRepo: ssh shorthand (git@github.com:owner/repo.git)', () => {
  assert.deepEqual(parseGithubOwnerRepo('git@github.com:owner/repo.git'), { owner: 'owner', repo: 'repo' });
});

test('parseGithubOwnerRepo: full ssh:// URL', () => {
  assert.deepEqual(parseGithubOwnerRepo('ssh://git@github.com/owner/repo.git'), { owner: 'owner', repo: 'repo' });
});

test('parseGithubOwnerRepo: a trailing slash on the URL does not leak into the repo name', () => {
  assert.deepEqual(parseGithubOwnerRepo('https://github.com/owner/repo/'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(parseGithubOwnerRepo('https://github.com/owner/repo.git/'), { owner: 'owner', repo: 'repo' });
});

test('parseGithubOwnerRepo: repo names containing dots are preserved (only the .git suffix is stripped)', () => {
  assert.deepEqual(parseGithubOwnerRepo('https://github.com/my-org/my.repo.git'), { owner: 'my-org', repo: 'my.repo' });
});

test('parseGithubOwnerRepo: a non-GitHub remote returns null', () => {
  assert.equal(parseGithubOwnerRepo('https://gitlab.com/owner/repo.git'), null);
  assert.equal(parseGithubOwnerRepo('/local/path/to/repo'), null);
});
