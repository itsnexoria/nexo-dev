'use strict';
// ---------- Input validation helpers ----------
// Names from the renderer (new file, rename) must be a single path segment,
// otherwise "../../x" escapes the target folder.
function isSafeName(name) {
  return typeof name === 'string' && name.trim() !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}
// Refs/hashes/URLs are passed as git arguments; a leading '-' would be parsed
// as an option (e.g. --upload-pack=<cmd> on clone => command execution).
function isSafeGitRef(ref) {
  return typeof ref === 'string' && ref.trim() !== '' && !ref.startsWith('-') && !/[\0\s]/.test(ref);
}
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
function isSafeExternalUrl(url) {
  try { return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(String(url)).protocol); } catch { return false; }
}


module.exports = { isSafeName, isSafeGitRef, isSafeExternalUrl };
