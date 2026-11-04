'use strict';
// HTTP client persistence (collections, environments, history) + {{variable}} substitution.
// Pure helpers are unit-tested in test/curl.test.js; the Store only does JSON file I/O.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIMITS = { folders: 100, requestsPerFolder: 500, envs: 50, vars: 200, history: 50, str: 200000 };
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const newId = () => crypto.randomBytes(6).toString('hex');
const str = (v, max = LIMITS.str) => (typeof v === 'string' ? v.slice(0, max) : '');
const id = (v) => (typeof v === 'string' && /^[a-f0-9]{6,32}$/.test(v) ? v : newId());

// "{{name}}" -> vars[name]; unknown variables are left as written. Single pass (no recursive expansion).
function substitute(text, vars) {
  if (typeof text !== 'string' || !vars) return text;
  return text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}
function unresolved(text, vars) {
  const out = new Set();
  String(text || '').replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (m, k) => { if (!vars || !Object.prototype.hasOwnProperty.call(vars, k)) out.add(k); return m; });
  return [...out];
}
function substituteRequest(req, vars) {
  const headers = {};
  const src = Array.isArray(req.headers) ? req.headers : Object.entries(req.headers || {}).map(([name, value]) => ({ name, value }));
  for (const h of src) headers[substitute(String(h.name), vars)] = substitute(String(h.value), vars);
  return { ...req, url: substitute(req.url, vars), headers, body: typeof req.body === 'string' ? substitute(req.body, vars) : req.body };
}

function cleanReq(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    id: id(r.id), name: str(r.name, 120) || 'Untitled', method: METHODS.includes(r.method) ? r.method : 'GET',
    url: str(r.url, 8192), headers: str(r.headers), body: str(r.body),
  };
}
function cleanDoc(d) {
  d = d && typeof d === 'object' ? d : {};
  const folders = (Array.isArray(d.folders) ? d.folders : []).slice(0, LIMITS.folders).map((f) => ({
    id: id(f && f.id), name: str(f && f.name, 120) || 'Folder',
    requests: (Array.isArray(f && f.requests) ? f.requests : []).slice(0, LIMITS.requestsPerFolder).map(cleanReq).filter(Boolean),
  }));
  const envs = (Array.isArray(d.envs) ? d.envs : []).slice(0, LIMITS.envs).map((e) => {
    const vars = {};
    let n = 0;
    for (const [k, v] of Object.entries((e && e.vars && typeof e.vars === 'object') ? e.vars : {})) {
      if (n++ >= LIMITS.vars) break;
      if (/^[A-Za-z0-9_.-]{1,64}$/.test(k)) vars[k] = str(String(v), 4096);
    }
    return { id: id(e && e.id), name: str(e && e.name, 80) || 'Environment', vars };
  });
  const activeEnv = envs.some((e) => e.id === d.activeEnv) ? d.activeEnv : null;
  const history = (Array.isArray(d.history) ? d.history : []).slice(0, LIMITS.history).map((h) => ({
    ...cleanReq(h), at: Number.isFinite(h && h.at) ? h.at : 0, status: Number.isFinite(h && h.status) ? h.status : null,
  })).filter((h) => h.url);
  return { folders, envs, activeEnv, history };
}

class HttpStore {
  constructor(file) { this.file = file; }
  load() {
    try { return cleanDoc(JSON.parse(fs.readFileSync(this.file, 'utf-8'))); } catch { return cleanDoc({}); }
  }
  save(doc) {
    const clean = cleanDoc(doc);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(clean));
    fs.renameSync(tmp, this.file);
    return clean;
  }
}
module.exports = { HttpStore, cleanDoc, substitute, substituteRequest, unresolved, METHODS, LIMITS };
