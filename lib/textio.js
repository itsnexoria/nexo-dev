'use strict';
// Encoding-aware text I/O: files that are not valid UTF-8 are decoded as Latin-1 (a lossless byte<->char
// mapping) and written back the same way, so opening and saving never corrupts their bytes.
const fs = require('fs');

function decodeUtf8Strict(buf) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch { return null; }
}
// -> { text, encoding: 'utf8' | 'latin1' }
function decodeText(buf) {
  const t = decodeUtf8Strict(buf);
  return t !== null ? { text: t, encoding: 'utf8' } : { text: buf.toString('latin1'), encoding: 'latin1' };
}
function encodeText(text, encoding) {
  if (encoding === 'latin1' && !/[^\u0000-ÿ]/.test(text)) return Buffer.from(text, 'latin1');
  return Buffer.from(text, 'utf-8');
}
function readTextFile(file) { return decodeText(fs.readFileSync(file)); }
module.exports = { decodeUtf8Strict, decodeText, encodeText, readTextFile };
