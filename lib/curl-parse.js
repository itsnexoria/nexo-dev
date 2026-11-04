'use strict';
// Pure curl command parser / generator for the HTTP client (unit-tested in test/curl.test.js).

// POSIX-ish tokenizer: '...', "..." (with \ escapes), $'...' (ANSI-C), backslash escapes and
// backslash-newline continuations. Unquoted ; | & > < end the command (we only parse the first one).
function tokenize(input) {
  const s = String(input).replace(/\r\n?/g, '\n');
  const out = [];
  let cur = '', has = false, i = 0;
  const push = () => { if (has) out.push(cur); cur = ''; has = false; };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < s.length) { cur += s[i + 1]; has = true; i += 2; continue; }
      i++; continue;
    }
    if (c === "'") {
      const e = s.indexOf("'", i + 1);
      if (e < 0) throw new Error('Unterminated single quote.');
      cur += s.slice(i + 1, e); has = true; i = e + 1; continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      i += 2; has = true;
      for (;;) {
        if (i >= s.length) throw new Error('Unterminated $\'…\' string.');
        const d = s[i];
        if (d === "'") { i++; break; }
        if (d === '\\') {
          const n = s[i + 1]; i += 2;
          const map = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b' };
          if (n === 'x') { const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i)); if (m) { cur += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; } else cur += 'x'; }
          else if (n === 'u') { const m = /^[0-9a-fA-F]{1,4}/.exec(s.slice(i)); if (m) { cur += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; } else cur += 'u'; }
          else if (/[0-7]/.test(n)) { const m = /^[0-7]{0,2}/.exec(s.slice(i)); cur += String.fromCharCode(parseInt(n + m[0], 8)); i += m[0].length; }
          else cur += map[n] !== undefined ? map[n] : '\\' + (n || '');
        } else { cur += d; i++; }
      }
      continue;
    }
    if (c === '"') {
      i++; has = true;
      for (;;) {
        if (i >= s.length) throw new Error('Unterminated double quote.');
        const d = s[i];
        if (d === '"') { i++; break; }
        if (d === '\\' && i + 1 < s.length) {
          const n = s[i + 1];
          if (n === '\n') { i += 2; continue; }
          if ('"\\$`'.includes(n)) { cur += n; i += 2; continue; }
          cur += d; i++; continue;
        }
        cur += d; i++;
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') { push(); i++; continue; }
    if (';|&<>'.includes(c) && !has && !cur) { break; }
    if (';|&'.includes(c)) { push(); break; }
    cur += c; has = true; i++;
  }
  push();
  return out;
}

// Options that take a value (short -> long alias where useful).
const WITH_VALUE = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode',
  '-F', '--form', '--form-string', '-u', '--user', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '--url', '-o', '--output', '-m', '--max-time',
  '--connect-timeout', '-x', '--proxy', '--cacert', '--cert', '--key', '-w', '--write-out', '--max-redirs', '--retry', '-T', '--upload-file', '--json',
  '--oauth2-bearer', '--resolve', '--http-version', '-K', '--config', '-c', '--cookie-jar', '--limit-rate', '-E', '-U', '--proxy-user', '--interface']);
const SHORT_WITH_VALUE = new Set(['X', 'H', 'd', 'F', 'u', 'A', 'e', 'b', 'o', 'm', 'x', 'w', 'T', 'K', 'c', 'E', 'U']);

function parseCurl(command) {
  const warnings = [];
  let toks = tokenize(command);
  // Allow pasted "$ curl ..." prompts.
  if (toks[0] === '$') toks.shift();
  if (!toks.length || !/^curl(\.exe)?$/i.test(toks[0].replace(/^.*[\\/]/, ''))) throw new Error('Not a curl command.');
  toks = toks.slice(1);

  const req = { method: null, url: '', headers: [], body: null, warnings };
  const dataParts = []; let dataKind = null; const forms = []; let head = false, getMode = false, user = null;
  let urlSeen = null;
  const addHeader = (h) => {
    const i = h.indexOf(':');
    if (i > 0) req.headers.push({ name: h.slice(0, i).trim(), value: h.slice(i + 1).trim() });
    else if (h.endsWith(';') ) req.headers.push({ name: h.slice(0, -1).trim(), value: '' });
    else warnings.push(`Ignored malformed header: ${h}`);
  };
  const handle = (opt, val) => {
    switch (opt) {
      case '-X': case '--request': req.method = String(val).toUpperCase(); break;
      case '-H': case '--header': addHeader(val); break;
      case '-d': case '--data': case '--data-ascii': case '--data-raw': case '--data-binary':
        if (opt !== '--data-raw' && val.startsWith('@')) { warnings.push(`Data from file ${val.slice(1)} is not supported; body left empty.`); dataParts.push(''); }
        else dataParts.push(val);
        dataKind = dataKind || 'raw'; break;
      case '--data-urlencode': {
        const eq = val.indexOf('=');
        if (val.startsWith('@')) { warnings.push('--data-urlencode @file is not supported.'); break; }
        dataParts.push(eq < 0 ? encodeURIComponent(val) : (eq === 0 ? '' : val.slice(0, eq) + '=') + encodeURIComponent(val.slice(eq + 1)));
        dataKind = dataKind || 'raw'; break;
      }
      case '--json': dataParts.push(val); dataKind = dataKind || 'json'; break;
      case '-F': case '--form': case '--form-string': forms.push(val); break;
      case '-u': case '--user': user = val; break;
      case '-A': case '--user-agent': req.headers.push({ name: 'User-Agent', value: val }); break;
      case '-e': case '--referer': req.headers.push({ name: 'Referer', value: val }); break;
      case '-b': case '--cookie': if (!val.includes('=')) warnings.push('Cookie file is not supported.'); else req.headers.push({ name: 'Cookie', value: val }); break;
      case '--oauth2-bearer': req.headers.push({ name: 'Authorization', value: 'Bearer ' + val }); break;
      case '--url': urlSeen = val; break;
      case '-I': case '--head': head = true; break;
      case '-G': case '--get': getMode = true; break;
      case '-T': case '--upload-file': warnings.push('--upload-file is not supported.'); if (!req.method) req.method = 'PUT'; break;
      default: break; // -L -k -s -S -v -i --compressed etc. are irrelevant here
    }
  };
  const positional = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '--') { positional.push(...toks.slice(i + 1)); break; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq > 0 ? t.slice(0, eq) : t;
      if (WITH_VALUE.has(name)) {
        let v;
        if (eq > 0) v = t.slice(eq + 1); else { v = toks[++i]; if (v === undefined) throw new Error(`Missing value for ${name}.`); }
        handle(name, v);
      } else handle(name, null);
      continue;
    }
    if (t.length > 1 && t[0] === '-') {
      // Bundle of short flags, last may take a value (-sSLXPOST, -XPOST, -H'a: b').
      for (let j = 1; j < t.length; j++) {
        const f = t[j];
        if (SHORT_WITH_VALUE.has(f)) {
          let v = t.slice(j + 1);
          if (!v) { v = toks[++i]; if (v === undefined) throw new Error(`Missing value for -${f}.`); }
          handle('-' + f, v); break;
        }
        handle('-' + f, null);
      }
      continue;
    }
    positional.push(t);
  }
  let url = urlSeen || positional[0] || '';
  if (!url) throw new Error('No URL found in the curl command.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(url) ? 'http://' : 'https://') + url;
  // Body
  if (forms.length) {
    warnings.push('multipart/form-data (-F) cannot be sent from this client; fields were placed in the body as plain text.');
    req.body = forms.join('\n'); if (!req.method) req.method = 'POST';
  } else if (dataParts.length) {
    const joined = dataKind === 'json' ? dataParts.join('') : dataParts.join('&');
    if (getMode) { url += (url.includes('?') ? '&' : '?') + joined; }
    else {
      req.body = joined;
      if (!req.method) req.method = 'POST';
      const hasCT = req.headers.some((h) => h.name.toLowerCase() === 'content-type');
      if (!hasCT) req.headers.push({ name: 'Content-Type', value: dataKind === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' });
      if (dataKind === 'json' && !req.headers.some((h) => h.name.toLowerCase() === 'accept')) req.headers.push({ name: 'Accept', value: 'application/json' });
    }
  }
  if (user != null) req.headers.push({ name: 'Authorization', value: 'Basic ' + Buffer.from(user).toString('base64') });
  if (head && !req.method) req.method = 'HEAD';
  if (!req.method) req.method = 'GET';
  if (!/^[A-Z]+$/.test(req.method)) throw new Error('Invalid HTTP method.');
  req.url = url;
  return req;
}

// POSIX single-quote escaping.
const sq = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";

// headers: object or [{name,value}] ; returns a multi-line copy-pasteable command.
function toCurl({ method = 'GET', url, headers = {}, body } = {}) {
  const parts = ['curl'];
  const m = String(method).toUpperCase();
  if (m === 'HEAD') parts.push('-I');
  else if (m !== 'GET' && !(m === 'POST' && body)) parts.push('-X ' + m);
  else if (m === 'GET' && body) parts.push('-X GET');
  parts.push(sq(url));
  const list = Array.isArray(headers) ? headers : Object.entries(headers).map(([name, value]) => ({ name, value }));
  for (const h of list) if (h.name) parts.push('-H ' + sq(`${h.name}: ${h.value}`));
  if (body) parts.push('--data-raw ' + sq(body));
  return parts.join(' \\\n  ');
}

module.exports = { tokenize, parseCurl, toCurl };
