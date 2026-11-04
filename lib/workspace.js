'use strict';
// .nexo-workspace parsing (main process uses it to grant filesystem scope to the listed folders).
const WS_EXT = '.nexo-workspace';
const sepOf = (p) => (p.includes('\\') && !p.includes('/') ? '\\' : '/');
const dirname = (p) => p.replace(/[\\/][^\\/]*$/, '') || p;
const norm = (p) => p.replace(/[\\/]+$/, '');

function parse(wsFile, text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Workspace file is not valid JSON.'); }
  if (!data || !Array.isArray(data.folders) || !data.folders.length) throw new Error('Workspace file lists no folders.');
  const base = dirname(wsFile), sep = sepOf(wsFile);
  const out = [];
  for (const f of data.folders.slice(0, 50)) {
    const p = typeof f === 'string' ? f : f && f.path;
    if (typeof p !== 'string' || !p.trim()) continue;
    const abs = /^([a-zA-Z]:[\\/]|[\\/])/.test(p) ? norm(p) : norm(base + sep + p.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep));
    if (!out.includes(abs)) out.push(abs);
  }
  if (!out.length) throw new Error('Workspace file lists no usable folders.');
  return out;
}
module.exports = { parse, WS_EXT };
