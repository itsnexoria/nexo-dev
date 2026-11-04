const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { register } = require('../lib/ipc-python');

function setup() {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const api = register({ ipcMain, getWindow: () => null, pythonEnvFor: () => ({}), findLocalEslintBin: () => null, OUTDATED_CACHE_TTL_MS: 1000 });
  return { handlers, api };
}

test('registers python, notebook, debugger and eslint channels', () => {
  const { handlers } = setup();
  for (const ch of ['py:info', 'py:select', 'py:lint', 'py:format', 'py:intel', 'nb:run', 'nb:restart', 'dbg:start', 'dbg:stop', 'eslint:lint']) assert.ok(handlers.has(ch), ch);
});
test('resolveVenvDir finds a venv with a python binary', () => {
  const { api } = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'py-'));
  assert.strictEqual(api.resolveVenvDir(root), null);
  const bin = api.venvBinDir(root, '.venv');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
  assert.strictEqual(api.resolveVenvDir(root), '.venv');
});
test('shutdown is safe with nothing running', () => {
  setup().api.shutdown();
});
