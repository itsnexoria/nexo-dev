// Parsers for git's machine-readable output formats — porcelain status,
// porcelain blame, and remote URLs. Pulled out of main.js on their own (same
// reasoning as lib/editorconfig.js and lib/search.js) so they can be
// unit-tested with plain Node, independent of Electron or a real git
// executable.
'use strict';

const CONFLICT_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
const labelFor = (c) => ({ M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Unmerged', '?': 'Untracked' }[c] || c);

// entries: [{ code: 'XY', path, renamedFrom }]
function classify(entries) {
  const staged = [];
  const unstaged = [];
  const conflicts = [];
  for (const { code, path, renamedFrom } of entries) {
    if (CONFLICT_CODES.has(code)) { conflicts.push({ path, code, renamedFrom }); continue; }
    if (code === '??') { unstaged.push({ path, status: '?', label: 'Untracked', renamedFrom }); continue; }
    if (code[0] !== ' ') staged.push({ path, status: code[0], label: labelFor(code[0]), renamedFrom });
    if (code[1] !== ' ') unstaged.push({ path, status: code[1], label: labelFor(code[1]), renamedFrom });
  }
  return { staged, unstaged, conflicts };
}

// Legacy newline-separated `git status --porcelain` (paths may be C-quoted by git).
function parsePorcelainStatus(stdout) {
  const entries = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    const code = line.slice(0, 2);
    let rest = line.slice(3);
    let renamedFrom = null;
    if (rest.includes(' -> ')) {
      const [from, to] = rest.split(' -> ');
      renamedFrom = from;
      rest = to;
    }
    entries.push({ code, path: rest, renamedFrom });
  }
  return classify(entries);
}

// `git status --porcelain -z`: NUL-separated and never quoted; a rename/copy record is followed by one extra
// field holding the original path.
function parsePorcelainStatusZ(stdout) {
  const parts = stdout.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;
    const code = rec.slice(0, 2);
    let renamedFrom = null;
    if (/[RC]/.test(code) && i + 1 < parts.length) { renamedFrom = parts[i + 1]; i++; }
    entries.push({ code, path: rec.slice(3), renamedFrom });
  }
  return classify(entries);
}

// Parses `git blame --line-porcelain` output. Full commit metadata is only
// emitted the first time each commit appears in the stream — later lines
// from the same commit just repeat the hash line then jump straight to the
// tab-prefixed content line — so metadata is cached by hash and reused.
function parseBlamePorcelain(output) {
  const lines = output.split('\n');
  const commits = {};
  const result = {};
  let i = 0;
  while (i < lines.length) {
    const header = lines[i].match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/);
    if (!header) { i++; continue; }
    const hash = header[1];
    const finalLine = parseInt(header[2], 10);
    i++;
    if (!commits[hash]) commits[hash] = { hash, author: '', time: 0, summary: '' };
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const l = lines[i];
      if (l.startsWith('author ')) commits[hash].author = l.slice(7);
      else if (l.startsWith('author-time ')) commits[hash].time = parseInt(l.slice(12), 10) || 0;
      else if (l.startsWith('summary ')) commits[hash].summary = l.slice(8);
      i++;
    }
    if (i < lines.length && lines[i].startsWith('\t')) i++; // consume the "\t<line content>" line
    result[finalLine] = commits[hash];
  }
  return result;
}

// A trailing slash is valid in a git remote URL (e.g. some tools/configs
// produce "https://github.com/owner/repo/") but was leaking into the parsed
// repo name — stripping it upfront keeps the owner/repo split correct.
function parseGithubOwnerRepo(remoteUrl) {
  const cleaned = remoteUrl.trim().replace(/\/+$/, '');
  const m = cleaned.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

module.exports = {
  parsePorcelainStatusZ,
  parsePorcelainStatus,
  parseBlamePorcelain,
  parseGithubOwnerRepo,
};
