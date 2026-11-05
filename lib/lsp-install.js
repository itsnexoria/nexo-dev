'use strict';
// "Auto-install" for language servers: installs the npm packages of a *known* server (looked up by id in
// lib/lsp-servers.js, never arbitrary input) into a private directory under userData. Nothing is written to the
// user's project, and lifecycle scripts are disabled.
const path = require('path');
const { SERVERS, managedPackages } = require('./lsp-servers');

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

const binDir = (dir) => path.join(dir, 'node_modules', '.bin');

// find(cmd) -> absolute path | null ; spawn = child_process.spawn (injectable for tests)
function install(id, { dir, find, spawn }) {
  return new Promise((resolve) => {
    const entry = SERVERS.find((s) => s.id === id);
    if (!entry) return resolve({ ok: false, error: 'Unknown language server.' });
    const pkgs = managedPackages(entry);
    if (!pkgs) return resolve({ ok: false, error: 'This server cannot be installed automatically.' + (entry.install && entry.install.other ? ' Manual: ' + entry.install.other : '') });
    const npm = find('npm');
    if (!npm) return resolve({ ok: false, error: 'npm was not found on PATH. Install Node.js, or run: ' + entry.install.npm });
    const args = ['install', '--prefix', dir, '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel', 'error', ...pkgs];
    let child, out = '', done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    try { child = spawn(npm, args, { windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(npm) }); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ ok: false, error: 'Install timed out.' }); }, INSTALL_TIMEOUT_MS);
    const grab = (d) => { out = (out + d).slice(-2000); };
    if (child.stdout) child.stdout.on('data', grab);
    if (child.stderr) child.stderr.on('data', grab);
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => finish(code === 0 ? { ok: true, packages: pkgs } : { ok: false, error: `npm exited with code ${code}.`, output: out.trim() }));
  });
}

module.exports = { install, binDir, INSTALL_TIMEOUT_MS };
