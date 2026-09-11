// A minimal implementation of https://editorconfig.org — parses [section]
// glob patterns and applies matching properties, closer files overriding
// farther ones.
//
// Pulled out of main.js on its own (rather than left inline) so it has no
// dependency on Electron and can be unit-tested with plain Node — see
// test/editorconfig.test.js.
'use strict';

const fs = require('fs');
const path = require('path');

function parseEditorConfigFile(content) {
  const sections = [];
  let current = null;
  for (const rawLine of content.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      current = { glob: sectionMatch[1], props: {} };
      sections.push(current);
      continue;
    }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const value = kv[2].trim().toLowerCase();
    if (!current) {
      sections.push({ glob: null, props: { [key]: value } }); // top-level (e.g. "root = true")
    } else {
      current.props[key] = value;
    }
  }
  return sections;
}

// Minimal EditorConfig glob support: * ** ? {a,b} [abc] [!abc]
function editorConfigGlobToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // "**/" should also match zero directories (gitignore convention,
          // which the spec explicitly follows) — without this, "**/*.js"
          // would fail to match a top-level "index.js".
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
        continue;
      }
      re += '[^/]*';
      continue;
    }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { re += '\\{'; continue; }
      const options = glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.*+^${}()|[\]\\]/g, '\\$&'));
      re += '(?:' + options.join('|') + ')';
      i = end;
      continue;
    }
    if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) { re += '\\['; continue; }
      let cls = glob.slice(i + 1, end);
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      re += '[' + cls + ']';
      i = end;
      continue;
    }
    re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  // A glob with no "/" matches the filename anywhere under the section's directory.
  const anchored = glob.includes('/') ? re.replace(/^\\\//, '') : '(?:.*/)?' + re;
  return new RegExp('^' + anchored + '$');
}

function readEditorConfigFile(dir) {
  try {
    const content = fs.readFileSync(path.join(dir, '.editorconfig'), 'utf-8');
    return parseEditorConfigFile(content);
  } catch {
    return null;
  }
}

// We only search upward from the file's own directory as far as the open
// project's root (not the whole filesystem), which is enough for the normal
// case and avoids reading arbitrary parent directories.
function resolveEditorConfigProps(projectRoot, absoluteFilePath) {
  const root = projectRoot ? path.resolve(projectRoot) : null;
  let dir = path.dirname(path.resolve(absoluteFilePath));
  // First pass: walk upward collecting candidate directories, stopping as
  // soon as we pass one whose .editorconfig declares root=true (inclusive)
  // or once we reach the project root — whichever comes first.
  const effectiveDirs = [];
  while (true) {
    effectiveDirs.push(dir);
    const sections = readEditorConfigFile(dir);
    if (sections && sections.some((s) => s.glob === null && s.props.root === 'true')) break;
    if (!root || dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  // Second pass: merge farthest-from-file first so closer .editorconfig
  // files (and later-matching sections within the same file) win.
  let merged = {};
  for (let i = effectiveDirs.length - 1; i >= 0; i--) {
    const configDir = effectiveDirs[i];
    const sections = readEditorConfigFile(configDir);
    if (!sections) continue;
    const relToConfig = path.relative(configDir, absoluteFilePath).split(path.sep).join('/');
    for (const section of sections) {
      if (section.glob === null) continue;
      let re;
      try { re = editorConfigGlobToRegExp(section.glob); } catch { continue; }
      if (re.test(relToConfig)) merged = { ...merged, ...section.props };
    }
  }
  return merged;
}

module.exports = {
  parseEditorConfigFile,
  editorConfigGlobToRegExp,
  readEditorConfigFile,
  resolveEditorConfigProps,
};
