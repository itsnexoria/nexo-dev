'use strict';
// Main-process filesystem scope. The renderer may only touch paths inside folders that the
// *main* process saw the user choose (dialogs, recent list, OS "open with", drag & drop,
// workspace files). A compromised renderer therefore cannot read/write arbitrary files.
const fs = require('fs');
const path = require('path');

const CI = process.platform === 'win32' || process.platform === 'darwin';
const key = (p) => (CI ? p.toLowerCase() : p);

// Resolve symlinks of the nearest existing ancestor so "<root>/link-to-etc/passwd" is caught.
function canonical(p) {
  let cur = path.resolve(String(p));
  const tail = [];
  for (;;) {
    try { cur = fs.realpathSync.native(cur); break; } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return path.join(cur, ...tail);
}

function within(child, parent) {
  const c = key(child), p = key(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

class Scope {
  constructor({ readOnlyRoots = [] } = {}) {
    this.roots = new Set();
    this.ro = readOnlyRoots.map(canonical);
  }
  addRoot(p) { if (typeof p === 'string' && p) this.roots.add(canonical(p)); }
  // A single file the user picked: its folder is *not* granted, only the file itself.
  addFile(p) { if (typeof p === 'string' && p) this.roots.add(canonical(p)); }
  allows(p, { write = true } = {}) {
    if (typeof p !== 'string' || !p || p.includes('\0')) return false;
    const c = canonical(p);
    for (const r of this.roots) if (within(c, r)) return true;
    if (!write) for (const r of this.ro) if (within(c, r)) return true;
    return false;
  }
}

// channel -> { args: [indexes that are filesystem paths], write: bool }
const READ = { write: false };
const PATH_ARGS = {
  'term:run': [[0]], 'lsp:start': [[1]], 'lsp:status': [[0], READ], 'live:start': [[0]],
  'shell:reveal': [[0]],
  'fs:read-dir': [[0], READ], 'fs:read-file': [[0], READ], 'fs:stat': [[0], READ], 'fs:exists': [[0], READ],
  'fs:write-file': [[0]], 'watch:start': [[0]], 'watch:stop': [[0]], 'fs:create-file': [[0]], 'fs:create-folder': [[0]],
  'fs:delete': [[0]], 'fs:rename': [[0]], 'fs:move': [[0, 1]],
  'editorconfig:resolve': [[0, 1], READ], 'todos:scan': [[0]], 'search:text': [[0]], 'search:replace-all': [[0]], 'fs:list-files': [[0]],
  'git:clone': [[1]],
  'prettier:format': [[0, 1]], 'npm:outdated': [[0]], 'eslint:lint': [[0, 1]],
  'py:info': [[0]], 'py:resolve': [[0]], 'py:list': [[0]], 'py:outdated': [[0]], 'py:lint': [[0, 1]], 'py:format': [[0, 1]],
  'py:intel': [[0]], 'py:lint-reset': [[0]], 'py:tests': [[0]], 'py:select': [[0]], 'nb:run': [[0, 1]], 'nb:restart': [[0]],
  'dbg:start': [[0, 1]], 'dbg:set-breakpoints': [[0]], 'njs:start': [[0, 1]], 'njs:set-breakpoints': [[0]],
  'github:list-releases': [[0]], 'github:create-release': [[0]], 'github:set-secret': [[0]], 'github:list-pulls': [[0]], 'github:list-issues': [[0]],
  'dbc:connect-file': [[0], READ],
};
for (const ch of ['status', 'blame', 'diff', 'stage', 'stage-all', 'unstage', 'unstage-all', 'discard', 'commit', 'branches',
  'checkout-branch', 'create-branch', 'log', 'ignored-paths', 'show-commit', 'remote-status', 'push', 'pull',
  'hunks', 'apply-selection', 'file-versions', 'commit-versions', 'commit-files', 'stash-list', 'stash-push', 'stash-apply', 'stash-pop', 'stash-drop', 'stash-show', 'graph', 'file-history']) PATH_ARGS['git:' + ch] = [[0]];

// channels that execute project-local code (binaries from node_modules/.bin, venvs, ...) -> index of the root arg.
// They are refused until the user trusts the folder (see lib/trust.js).
const TRUST_ARGS = {
  'prettier:format': 0, 'eslint:lint': 0, 'lsp:start': 1, 'py:info': 0, 'py:resolve': 0, 'py:list': 0, 'py:outdated': 0,
  'py:lint': 0, 'py:format': 0, 'py:intel': 0, 'py:tests': 0, 'nb:run': 0, 'dbg:start': 0, 'njs:start': 0,
};
PATH_ARGS['trust:grant'] = [[0]];

// Wraps ipcMain.handle so every handler is sender-checked and path-scoped.
function installGuard(ipcMain, { scope, isTrustedSender, trust }) {
  const orig = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => orig(channel, (evt, ...args) => {
    if (!isTrustedSender(evt)) return { ok: false, error: 'Untrusted sender.' };
    const spec = PATH_ARGS[channel];
    if (spec) {
      const write = !(spec[1] && spec[1].write === false);
      for (const i of spec[0]) {
        if (args[i] === undefined) continue; // optional arg
        if (!scope.allows(args[i], { write })) return { ok: false, error: 'Path is outside the open workspace.', code: 'EOUTSCOPE' };
      }
    }
    if (trust && TRUST_ARGS[channel] !== undefined && !trust.isTrusted(args[TRUST_ARGS[channel]])) {
      return { ok: false, error: 'This folder is not trusted. Trust it to run project tools (Restricted Mode).', code: 'EUNTRUSTED' };
    }
    return fn(evt, ...args);
  });
}

module.exports = { Scope, installGuard, PATH_ARGS, TRUST_ARGS, canonical, within };
