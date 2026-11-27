'use strict';
const path = require('path');
const { Worker } = require('worker_threads');

// kind: 'search' | 'replace'. Resolves { ok, results } | { ok:false, error, timedOut }.
function runJob(job, { timeoutMs = 20000, onWritten } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const w = new Worker(path.join(__dirname, 'search-worker.js'), { workerData: job });
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); w.terminate().catch(() => {}); resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, timedOut: true, error: 'Timed out — the pattern is too slow for this project. Simplify the regular expression.' }), timeoutMs);
    w.on('message', (m) => {
      if (m.type === 'written') { if (onWritten) onWritten(m.path); } else if (m.type === 'done') finish({ ok: true, results: m.results });
      else if (m.type === 'error') finish({ ok: false, error: m.error });
    });
    w.on('error', (e) => finish({ ok: false, error: e.message }));
    w.on('exit', () => finish({ ok: false, error: 'Search worker stopped unexpectedly.' }));
  });
}
module.exports = { runJob };
