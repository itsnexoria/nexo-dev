'use strict';
const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_CODE = 512 * 1024;

function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['manifest must be an object'] };
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) errors.push('id must match ' + ID_RE);
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80) errors.push('name is required (max 80 chars)');
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) errors.push('version must be semver (x.y.z)');
  if (m.main != null && (typeof m.main !== 'string' || path.isAbsolute(m.main) || m.main.split(/[\\/]/).includes('..') || !/\.js$/.test(m.main))) errors.push('main must be a relative .js path inside the extension');
  const out = { id: m.id, name: m.name, version: m.version, description: typeof m.description === 'string' ? m.description.slice(0, 300) : '', main: m.main || null, commands: [], snippets: [], themes: [] };
  if (m.commands != null) {
    if (!Array.isArray(m.commands)) errors.push('commands must be an array');
    else for (const c of m.commands) {
      if (!c || typeof c.id !== 'string' || !ID_RE.test(c.id) || typeof c.title !== 'string' || !c.title) errors.push('each command needs id and title');
      else out.commands.push({ id: c.id, title: c.title.slice(0, 100) });
    }
  }
  if (m.snippets != null) {
    if (!Array.isArray(m.snippets)) errors.push('snippets must be an array');
    else for (const s of m.snippets) {
      if (!s || typeof s.language !== 'string' || typeof s.prefix !== 'string' || typeof s.body !== 'string' || !s.prefix) errors.push('each snippet needs language, prefix and body');
      else out.snippets.push({ language: s.language, prefix: s.prefix, body: s.body.slice(0, 20000), description: typeof s.description === 'string' ? s.description : '' });
    }
  }
  if (m.themes != null) {
    if (!Array.isArray(m.themes)) errors.push('themes must be an array');
    else for (const t of m.themes) {
      const okColors = t && t.colors && typeof t.colors === 'object' && Object.values(t.colors).every((v) => typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v));
      if (!t || typeof t.id !== 'string' || !ID_RE.test(t.id) || typeof t.name !== 'string' || !['vs', 'vs-dark'].includes(t.base) || !okColors) errors.push('each theme needs id, name, base (vs|vs-dark) and hex colors');
      else out.themes.push({ id: t.id, name: t.name, base: t.base, colors: t.colors, rules: Array.isArray(t.rules) ? t.rules.filter((r) => r && typeof r.token === 'string').map((r) => ({ token: r.token, foreground: String(r.foreground || '').replace('#', '') || undefined, fontStyle: r.fontStyle })) : [] });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], manifest: out };
}

function scan(dir, disabled = []) {
  const res = [];
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return res; }
  for (const name of names) {
    const root = path.join(dir, name);
    try {
      const v = validateManifest(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')));
      if (!v.ok) { res.push({ id: name, dir: root, error: v.errors.join('; '), enabled: false }); continue; }
      if (v.manifest.id !== name) { res.push({ id: name, dir: root, error: 'folder name must equal manifest id', enabled: false }); continue; }
      let code = '';
      if (v.manifest.main) {
        const file = path.resolve(root, v.manifest.main);
        if (!file.startsWith(root + path.sep)) { res.push({ id: name, dir: root, error: 'main escapes extension folder', enabled: false }); continue; }
        const st = fs.statSync(file);
        if (st.size > MAX_CODE) { res.push({ id: name, dir: root, error: 'main is too large', enabled: false }); continue; }
        code = fs.readFileSync(file, 'utf8');
      }
      res.push({ id: name, dir: root, manifest: v.manifest, code, enabled: !disabled.includes(name) });
    } catch (e) { res.push({ id: name, dir: root, error: 'invalid manifest.json: ' + e.message, enabled: false }); }
  }
  return res;
}
module.exports = { validateManifest, scan, ID_RE };
