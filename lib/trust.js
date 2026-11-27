'use strict';
// Workspace trust: folders whose project-local tools (node_modules/.bin, venv interpreters, ...) may be executed.
// Untrusted folders open in "Restricted Mode": editing works, but nothing from the project is run automatically.
const fs = require('fs');
const path = require('path');
const { canonical, within } = require('./scope');
const { writeFileAtomic } = require('./atomic');

class TrustStore {
  constructor(file, { trustAll = false } = {}) { this.file = file; this.trustAll = trustAll; this.cache = null; }
  _load() {
    if (this.cache) return this.cache;
    let list = [];
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (Array.isArray(d.trusted)) list = d.trusted.filter((x) => typeof x === 'string'); } catch { /* none yet */ }
    return (this.cache = list);
  }
  _save(list) {
    this.cache = list;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ trusted: list }, null, 2));
  }
  list() { return [...this._load()]; }
  isTrusted(p) {
    if (this.trustAll) return true;
    if (typeof p !== 'string' || !p) return false;
    const c = canonical(p);
    return this._load().some((r) => within(c, r));
  }
  add(p) { const c = canonical(p); const l = this._load(); if (!l.includes(c)) this._save([...l, c].slice(-200)); }
  remove(p) { const c = canonical(p); this._save(this._load().filter((r) => r !== c)); }
}
module.exports = { TrustStore };
