'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseEditorConfigFile,
  editorConfigGlobToRegExp,
  resolveEditorConfigProps,
} = require('../lib/editorconfig');

// ---------- parseEditorConfigFile ----------

test('parseEditorConfigFile: reads a top-level root=true plus one section', () => {
  const sections = parseEditorConfigFile(`
root = true

[*]
indent_style = space
indent_size = 2
`);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].glob, null);
  assert.equal(sections[0].props.root, 'true');
  assert.equal(sections[1].glob, '*');
  assert.equal(sections[1].props.indent_style, 'space');
  assert.equal(sections[1].props.indent_size, '2');
});

test('parseEditorConfigFile: ignores comments and blank lines', () => {
  const sections = parseEditorConfigFile(`
; a semicolon comment
# a hash comment

[*.md]
trim_trailing_whitespace = false
`);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].glob, '*.md');
  assert.equal(sections[0].props.trim_trailing_whitespace, 'false');
});

test('parseEditorConfigFile: keys and values are lowercased, whitespace trimmed', () => {
  const sections = parseEditorConfigFile('[*]\n  Indent_Style  =  Tab  \n');
  assert.equal(sections[0].props.indent_style, 'tab');
});

test('parseEditorConfigFile: handles CRLF line endings', () => {
  const sections = parseEditorConfigFile('[*]\r\nindent_size = 4\r\n');
  assert.equal(sections[0].props.indent_size, '4');
});

// ---------- editorConfigGlobToRegExp ----------

test('editorConfigGlobToRegExp: "*" matches a bare filename', () => {
  const re = editorConfigGlobToRegExp('*');
  assert.ok(re.test('index.js'));
  assert.ok(re.test('README.md'));
});

test('editorConfigGlobToRegExp: "*.js" (no slash) matches at any depth, per spec ("**/" is implied)', () => {
  const re = editorConfigGlobToRegExp('*.js');
  assert.ok(re.test('index.js'));
  assert.ok(re.test('src/index.js')); // a slash-less glob is treated as **/glob
  assert.ok(!re.test('index.ts'));
});

test('editorConfigGlobToRegExp: "**/*.js" matches at any depth', () => {
  const re = editorConfigGlobToRegExp('**/*.js');
  assert.ok(re.test('index.js'));
  assert.ok(re.test('src/deep/index.js'));
});

test('editorConfigGlobToRegExp: brace groups match any listed option', () => {
  const re = editorConfigGlobToRegExp('*.{js,ts,jsx,tsx}');
  assert.ok(re.test('a.js'));
  assert.ok(re.test('a.tsx'));
  assert.ok(!re.test('a.css'));
});

test('editorConfigGlobToRegExp: bracket character classes and negation', () => {
  assert.ok(editorConfigGlobToRegExp('file[0-9].txt').test('file5.txt'));
  assert.ok(!editorConfigGlobToRegExp('file[0-9].txt').test('fileA.txt'));
  assert.ok(editorConfigGlobToRegExp('file[!0-9].txt').test('fileA.txt'));
  assert.ok(!editorConfigGlobToRegExp('file[!0-9].txt').test('file5.txt'));
});

// ---------- resolveEditorConfigProps (integration against a real temp tree) ----------

function makeTempProject(structure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-editorconfig-'));
  for (const [relPath, content] of Object.entries(structure)) {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('resolveEditorConfigProps: applies root-level settings to a matching file', () => {
  const root = makeTempProject({
    '.editorconfig': 'root = true\n\n[*]\nindent_style = space\nindent_size = 2\n',
    'src/index.js': 'console.log(1);\n',
  });
  const props = resolveEditorConfigProps(root, path.join(root, 'src/index.js'));
  assert.equal(props.indent_style, 'space');
  assert.equal(props.indent_size, '2');
});

test('resolveEditorConfigProps: a closer .editorconfig overrides a farther one', () => {
  const root = makeTempProject({
    '.editorconfig': 'root = true\n\n[*]\nindent_style = space\nindent_size = 2\n',
    'vendor/.editorconfig': '[*]\nindent_style = tab\n',
    'vendor/lib.js': 'x = 1;\n',
  });
  const props = resolveEditorConfigProps(root, path.join(root, 'vendor/lib.js'));
  assert.equal(props.indent_style, 'tab'); // overridden by the closer file
  assert.equal(props.indent_size, '2'); // inherited from the root file (not overridden)
});

test('resolveEditorConfigProps: only the matching glob section applies', () => {
  const root = makeTempProject({
    '.editorconfig': 'root = true\n\n[*.md]\ntrim_trailing_whitespace = false\n\n[*.js]\ntrim_trailing_whitespace = true\n',
    'notes.md': '# hi\n',
    'index.js': 'x = 1;\n',
  });
  const mdProps = resolveEditorConfigProps(root, path.join(root, 'notes.md'));
  const jsProps = resolveEditorConfigProps(root, path.join(root, 'index.js'));
  assert.equal(mdProps.trim_trailing_whitespace, 'false');
  assert.equal(jsProps.trim_trailing_whitespace, 'true');
});

test('resolveEditorConfigProps: does not search above the project root', () => {
  // A .editorconfig placed at os.tmpdir() (an ancestor of every temp project)
  // must never leak into a project's resolved props.
  const outerMarker = path.join(os.tmpdir(), '.editorconfig');
  const hadOuter = fs.existsSync(outerMarker);
  const previousOuter = hadOuter ? fs.readFileSync(outerMarker, 'utf-8') : null;
  fs.writeFileSync(outerMarker, '[*]\nindent_style = tab\n');
  try {
    const root = makeTempProject({
      '.editorconfig': 'root = true\n\n[*]\nindent_style = space\n',
      'index.js': 'x = 1;\n',
    });
    const props = resolveEditorConfigProps(root, path.join(root, 'index.js'));
    assert.equal(props.indent_style, 'space');
  } finally {
    if (previousOuter === null) fs.unlinkSync(outerMarker); else fs.writeFileSync(outerMarker, previousOuter);
  }
});

test('resolveEditorConfigProps: returns an empty object when no .editorconfig exists', () => {
  const root = makeTempProject({ 'index.js': 'x = 1;\n' });
  const props = resolveEditorConfigProps(root, path.join(root, 'index.js'));
  assert.deepEqual(props, {});
});
