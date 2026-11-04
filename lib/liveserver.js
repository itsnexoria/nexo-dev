'use strict';
// Static dev server with live reload (Server-Sent Events). HTML responses get a
// tiny client injected; any file change under root triggers a reload.
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.wasm': 'application/wasm', '.map': 'application/json',
};
const CLIENT = '<script>(function(){var e=new EventSource("/__nexo_live");e.onmessage=function(m){if(m.data==="reload")location.reload()};})();</script>';

// Resolve a URL path to a file strictly inside root (blocks ../ and symlink escapes).
function resolveSafe(root, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); } catch { return null; }
  if (rel.includes('\0')) return null;
  const full = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  const realRoot = fs.realpathSync(root);
  if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) return null;
  try {
    const real = fs.realpathSync(full);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  } catch { /* nonexistent: caller handles 404 */ }
  return full;
}

function startLiveServer({ root, port = 0, host = '127.0.0.1' }) {
  root = path.resolve(root);
  const clients = new Set();
  let timer = null;
  const broadcast = () => { for (const res of clients) res.write('data: reload\n\n'); };

  const server = http.createServer((req, res) => {
    // DNS-rebinding guard: only answer requests addressed to a loopback name.
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(req.headers.host || ''))) { res.writeHead(421); return res.end('Misdirected request'); }
    if (req.url === '/__nexo_live') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let file = resolveSafe(root, req.url);
    if (!file) { res.writeHead(403); return res.end('Forbidden'); }
    // Never serve dotfiles/dot-directories (.env, .git/config, ...) except .well-known.
    if (path.relative(root, file).split(path.sep).some((seg) => seg.startsWith('.') && seg !== '.well-known')) { res.writeHead(403); return res.end('Forbidden'); }
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch { /* falls through to 404 */ }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found: ' + req.url); }
      const ext = path.extname(file).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' };
      if (ext === '.html' || ext === '.htm') {
        let html = data.toString('utf-8');
        html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, CLIENT + '</body>') : html + CLIENT;
        res.writeHead(200, headers);
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });

  let watcher = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (evt, name) => {
      if (name && /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(name)) return;
      clearTimeout(timer);
      timer = setTimeout(broadcast, 80);
    });
    watcher.on('error', () => {});
  } catch { /* recursive watch unsupported: manual refresh only */ }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://${host === '127.0.0.1' ? 'localhost' : host}:${actual}/`,
        reload: broadcast,
        close: () => new Promise((r) => {
          clearTimeout(timer);
          if (watcher) watcher.close();
          for (const c of clients) c.end();
          server.close(() => r());
          server.closeAllConnections && server.closeAllConnections();
        }),
      });
    });
  });
}

module.exports = { startLiveServer, resolveSafe };
