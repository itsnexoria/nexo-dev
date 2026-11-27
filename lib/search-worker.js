'use strict';
// Runs a search / replace job off the main thread so a pathological regex cannot freeze the app.
const { parentPort, workerData } = require('worker_threads');
const { walkForSearch, walkForReplace, buildReplaceRegExp } = require('./search');

(async () => {
  const { kind, root, query, replacement, opts } = workerData;
  try {
    if (kind === 'search') {
      const results = { matches: [], matchedFiles: 0 };
      await walkForSearch(root, query, !!opts.caseSensitive, results, !!opts.useRegex);
      parentPort.postMessage({ type: 'done', results });
    } else {
      const { re, safeReplacement } = buildReplaceRegExp(query, replacement, opts);
      const results = { filesChanged: 0, totalReplacements: 0, changedPaths: [], errors: [], skipped: 0 };
      await walkForReplace(root, re, safeReplacement, results, (p) => parentPort.postMessage({ type: 'written', path: p }));
      parentPort.postMessage({ type: 'done', results });
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: String((err && err.message) || err) });
  }
})();
