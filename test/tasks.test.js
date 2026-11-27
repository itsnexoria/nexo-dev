const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/tasks');

test('detectTasks: package scripts, nexo and vscode tasks', () => {
  const t = T.detectTasks({
    packageJson: { scripts: { build: 'node build.js', lint: 'eslint .', typecheck: 'tsc -p .' } }, packageManager: 'pnpm',
    nexoTasks: { tasks: [{ label: 'Make', command: 'make', args: ['all', 'a b'], problemMatcher: '$gcc' }] },
    vscodeTasks: T.parseJsonc('{ // c\n "tasks": [ { "label": "x", "command": "echo hi", }, ], /* end */ }'),
  });
  assert.equal(t.find((x) => x.label === 'build').command, 'pnpm run build');
  assert.equal(t.find((x) => x.label === 'lint').matcher, 'eslint');
  assert.equal(t.find((x) => x.label === 'typecheck').matcher, 'tsc');
  assert.equal(t.find((x) => x.label === 'Make').command, 'make all "a b"');
  assert.equal(t.find((x) => x.label === 'Make').matcher, 'gcc');
  assert.equal(t.find((x) => x.source === '.vscode/tasks.json').command, 'echo hi');
});

test('parseJsonc keeps // inside strings', () => {
  assert.deepEqual(T.parseJsonc('{"u":"http://x" // c\n}'), { u: 'http://x' });
});

test('parseProblems: tsc, gcc, eslint, python, ansi, dedupe, node_modules', () => {
  const out = [
    'src/a.ts(3,5): error TS2322: Type mismatch.',
    'src/a.ts(3,5): error TS2322: Type mismatch.',
    'main.c:10:2: warning: unused variable',
    '/proj/b.js',
    '  4:7  error  Unexpected var  no-var',
    '  9:1  warning  Missing semi  semi',
    '  File "/proj/x.py", line 12, in <module>',
    'ValueError: bad',
    '\u001b[31mnode_modules/q/i.js:1:1: error: skip\u001b[0m',
  ].join('\n');
  const p = T.parseProblems(out, '/proj');
  assert.equal(p.length, 5);
  assert.deepEqual(p[0], { file: '/proj/src/a.ts', line: 3, col: 5, severity: 'error', message: 'Type mismatch. (TS2322)' });
  assert.equal(p[1].severity, 'warning');
  assert.equal(p[2].file, '/proj/b.js');
  assert.equal(p[2].message, 'Unexpected var (no-var)');
  assert.equal(p[4].file, '/proj/x.py');
  assert.equal(p[4].line, 12);
});

test('resolvePath handles relative, parent and windows paths', () => {
  assert.equal(T.resolvePath('../a.js', '/p/q'), '/p/a.js');
  assert.equal(T.resolvePath('a\\b.js', 'C:\\p'), 'C:\\p\\a\\b.js');
  assert.equal(T.resolvePath('/abs/x', '/p'), '/abs/x');
});

test('parseProblems ignores command echo lines', () => {
  assert.equal(T.parseProblems('> node -e "x a.js:2:5: error: boom"\n$ cc a.c:1:1: error: x', '/p').length, 0);
});
