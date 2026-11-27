'use strict';
// Worker-thread host for SqliteImpl: a runaway query can be killed by terminating the worker
// instead of freezing the main process.
const { parentPort } = require('worker_threads');
const { SqliteImpl } = require('./sqlite-impl');

const impl = new SqliteImpl();
const ALLOWED = new Set(['open', 'setWrites', 'listTables', 'tableSchema', 'browse', 'query', 'updateCell', 'export', 'markClean', 'close']);
parentPort.on('message', async ({ id, method, args }) => {
  try {
    if (!ALLOWED.has(method)) throw new Error('Unknown method.');
    const value = await impl[method](...(args || []));
    parentPort.postMessage({ id, ok: true, value });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
});
