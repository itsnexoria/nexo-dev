'use strict';
// REST request runner for the HTTP client panel.
const MAX_BODY = 5 * 1024 * 1024;

async function sendRequest({ method = 'GET', url, headers = {}, body, timeoutMs = 30000 }) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'Invalid URL.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Only http(s) URLs are supported.' };
  method = String(method).toUpperCase();
  if (!/^[A-Z]+$/.test(method)) return { ok: false, error: 'Invalid method.' };
  const init = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1000, Math.min(120000, timeoutMs))) };
  if (body && method !== 'GET' && method !== 'HEAD') init.body = body;
  const t0 = Date.now();
  try {
    const res = await fetch(u, init);
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > MAX_BODY;
    const out = (truncated ? buf.subarray(0, MAX_BODY) : buf).toString('utf-8');
    const hdrs = {};
    res.headers.forEach((v, k) => { hdrs[k] = v; });
    return { ok: true, status: res.status, statusText: res.statusText, headers: hdrs, body: out, size: buf.length, truncated, timeMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'Request timed out.' : (err.cause && err.cause.code) || err.message };
  }
}
module.exports = { sendRequest };
