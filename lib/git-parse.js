// Parsers for git's machine-readable output formats — porcelain status,
// porcelain blame, and remote URLs. Pulled out of main.js on their own (same
// reasoning as lib/editorconfig.js and lib/search.js) so they can be
// unit-tested with plain Node, independent of Electron or a real git
// executable.
'use strict';

function parsePorcelainStatus(stdout) {
  const staged = [];
  const unstaged = [];
  const conflicts = [];
  const CONFLICT_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
  const lines = stdout.split('\n').filter(Boolean);
  for (const line of lines) {
    const code = line.slice(0, 2);
    let rest = line.slice(3);
    let renamedFrom = null;
    if (rest.includes(' -> ')) {
      const [from, to] = rest.split(' -> ');
      renamedFrom = from;
      rest = to;
    }
    if (CONFLICT_CODES.has(code)) {
      conflicts.push({ path: rest, code, renamedFrom });
      continue;
    }
    const indexCode = code[0];
    const worktreeCode = code[1];
    const labelFor = (c) => ({ M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Unmerged', '?': 'Untracked' }[c] || c);

    if (code === '??') {
      unstaged.push({ path: rest, status: '?', label: 'Untracked', renamedFrom });
      continue;
    }
    if (indexCode !== ' ') {
      staged.push({ path: rest, status: indexCode, label: labelFor(indexCode), renamedFrom });
    }
    if (worktreeCode !== ' ') {
      unstaged.push({ path: rest, status: worktreeCode, label: labelFor(worktreeCode), renamedFrom });
    }
  }
  return { staged, unstaged, conflicts };
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
  parsePorcelainStatus,
  parseBlamePorcelain,
  parseGithubOwnerRepo,
};
