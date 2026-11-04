'use strict';
// Extra git IPC: hunk/line staging, stash, side-by-side diff sources, commit graph, file history.
// Everything runs `git` with an argv array (no shell) and `--` before any path.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseDiff, buildPatch } = require('./git-patch');
const { computeGraph } = require('./git-graph');

function git(args, cwd, input) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; if (out.length > 30 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, stdout: '', stderr: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout: out, stderr: err }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}
const safeRel = (rel) => typeof rel === 'string' && rel && !rel.includes('\0') && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');
const isIdx = (n) => Number.isInteger(n) && n >= 0 && n < 10000;

async function rootOf(projectRoot) {
  const r = await git(['rev-parse', '--show-toplevel'], projectRoot);
  return r.ok ? r.stdout.trim() : null;
}

function register({ ipcMain }) {
  const guard = (fn) => async (evt, projectRoot, ...args) => {
    try {
      const root = await rootOf(projectRoot);
      if (!root) return { ok: false, error: 'Not a git repository.' };
      return await fn(root, ...args);
    } catch (err) { return { ok: false, error: err.message }; }
  };

  ipcMain.handle('git:hunks', guard(async (root, rel, staged) => {
    if (!safeRel(rel)) return { ok: false, error: 'Invalid path.' };
    const r = await git(staged ? ['diff', '--cached', '--no-color', '--', rel] : ['diff', '--no-color', '--', rel], root);
    if (!r.ok) return { ok: false, error: r.stderr };
    const parsed = parseDiff(r.stdout);
    return { ok: true, binary: parsed.binary, hunks: parsed.hunks.map((h, index) => ({ index, oldStart: h.oldStart, newStart: h.newStart, section: h.section, lines: h.lines })) };
  }));

  // mode: 'stage' (unstaged -> index), 'unstage' (index -> HEAD), 'discard' (drop unstaged changes)
  ipcMain.handle('git:apply-selection', guard(async (root, rel, mode, selection) => {
    if (!safeRel(rel)) return { ok: false, error: 'Invalid path.' };
    if (!['stage', 'unstage', 'discard'].includes(mode) || !Array.isArray(selection)) return { ok: false, error: 'Invalid request.' };
    const cached = mode === 'unstage';
    const d = await git(cached ? ['diff', '--cached', '--no-color', '--', rel] : ['diff', '--no-color', '--', rel], root);
    if (!d.ok) return { ok: false, error: d.stderr };
    const patch = buildPatch(parseDiff(d.stdout), selection, { reverse: mode !== 'stage' });
    if (!patch) return { ok: false, error: 'Nothing selected.' };
    const args = ['apply', '--recount', '--whitespace=nowarn'];
    if (mode !== 'discard') args.push('--cached');
    if (mode !== 'stage') args.push('-R');
    const r = await git(args.concat('-'), root, patch);
    return r.ok ? { ok: true } : { ok: false, error: r.stderr || 'git apply failed.' };
  }));

  // Both sides of a file for the side-by-side diff editor.
  ipcMain.handle('git:file-versions', guard(async (root, rel, staged) => {
    if (!safeRel(rel)) return { ok: false, error: 'Invalid path.' };
    const show = async (spec) => { const r = await git(['show', spec], root); return r.ok ? r.stdout : ''; };
    let original; let modified;
    if (staged) { original = await show('HEAD:' + rel.replace(/\\/g, '/')); modified = await show(':' + rel.replace(/\\/g, '/')); }
    else {
      const idx = await git(['show', ':' + rel.replace(/\\/g, '/')], root);
      original = idx.ok ? idx.stdout : '';
      try { modified = fs.readFileSync(path.join(root, rel), 'utf-8'); } catch { modified = ''; }
    }
    return { ok: true, original, modified };
  }));
  ipcMain.handle('git:commit-versions', guard(async (root, hash, rel) => {
    if (!/^[0-9a-fA-F]{4,64}$/.test(String(hash)) || !safeRel(rel)) return { ok: false, error: 'Invalid request.' };
    const p = rel.replace(/\\/g, '/');
    const a = await git(['show', `${hash}^:${p}`], root);
    const b = await git(['show', `${hash}:${p}`], root);
    return { ok: true, original: a.ok ? a.stdout : '', modified: b.ok ? b.stdout : '' };
  }));
  ipcMain.handle('git:commit-files', guard(async (root, hash) => {
    if (!/^[0-9a-fA-F]{4,64}$/.test(String(hash))) return { ok: false, error: 'Invalid hash.' };
    const r = await git(['show', '--name-status', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%B%x1e', hash, '--'], root);
    if (!r.ok) return { ok: false, error: r.stderr };
    const [head, rest] = r.stdout.split('\x1e');
    const [h, an, ae, date, body] = head.split('\x1f');
    const files = (rest || '').split('\n').filter(Boolean).map((l) => { const [status, ...p] = l.split('\t'); return { status: status[0], path: p[p.length - 1] }; });
    return { ok: true, hash: h, author: an, email: ae, date, message: (body || '').trim(), files };
  }));

  // ----- stash -----
  ipcMain.handle('git:stash-list', guard(async (root) => {
    const r = await git(['stash', 'list', '--format=%gd%x1f%s%x1f%ar'], root);
    if (!r.ok) return { ok: false, error: r.stderr };
    return { ok: true, stashes: r.stdout.split('\n').filter(Boolean).map((l, index) => { const [ref, subject, date] = l.split('\x1f'); return { index, ref, subject, date }; }) };
  }));
  ipcMain.handle('git:stash-push', guard(async (root, message, includeUntracked) => {
    const args = ['stash', 'push'];
    if (includeUntracked) args.push('--include-untracked');
    if (typeof message === 'string' && message.trim()) args.push('-m', message.trim().slice(0, 200));
    const r = await git(args, root);
    return { ok: r.ok, error: r.ok ? null : r.stderr, nothing: /No local changes/i.test(r.stdout + r.stderr) };
  }));
  for (const op of ['apply', 'pop', 'drop']) {
    ipcMain.handle('git:stash-' + op, guard(async (root, index) => {
      if (!isIdx(index)) return { ok: false, error: 'Invalid stash.' };
      const r = await git(['stash', op, `stash@{${index}}`], root);
      return { ok: r.ok, error: r.ok ? null : (r.stderr || r.stdout) };
    }));
  }
  ipcMain.handle('git:stash-show', guard(async (root, index) => {
    if (!isIdx(index)) return { ok: false, error: 'Invalid stash.' };
    const r = await git(['stash', 'show', '-p', '--no-color', `stash@{${index}}`], root);
    return r.ok ? { ok: true, diff: r.stdout } : { ok: false, error: r.stderr };
  }));

  // ----- graph / history -----
  ipcMain.handle('git:graph', guard(async (root, limit) => {
    const n = Math.max(1, Math.min(1000, parseInt(limit, 10) || 200));
    const r = await git(['log', '--all', '--topo-order', `-n${n}`, '--format=%H%x1f%P%x1f%h%x1f%an%x1f%ar%x1f%D%x1f%s'], root);
    if (!r.ok) return { ok: false, error: r.stderr || 'No commits yet.' };
    const commits = r.stdout.split('\n').filter(Boolean).map((l) => {
      const [hash, parents, short, author, date, refs, subject] = l.split('\x1f');
      return { hash, parents: parents ? parents.split(' ') : [], short, author, date, refs: refs ? refs.split(', ').filter(Boolean) : [], subject };
    });
    const rows = computeGraph(commits);
    return { ok: true, commits, rows };
  }));
  ipcMain.handle('git:file-history', guard(async (root, rel) => {
    if (!safeRel(rel)) return { ok: false, error: 'Invalid path.' };
    const r = await git(['log', '--follow', '-n200', '--format=%H%x1f%h%x1f%an%x1f%ar%x1f%s', '--', rel], root);
    if (!r.ok) return { ok: false, error: r.stderr };
    return { ok: true, commits: r.stdout.split('\n').filter(Boolean).map((l) => { const [hash, short, author, date, subject] = l.split('\x1f'); return { hash, short, author, date, subject }; }) };
  }));
}
module.exports = { register };
