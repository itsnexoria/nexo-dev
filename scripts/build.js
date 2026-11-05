'use strict';
// Concatenates src/** in order.json order (one shared script scope, exactly like the
// original single renderer.js) and transpiles TypeScript -> renderer/dist/renderer.js.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const order = JSON.parse(fs.readFileSync(path.join(root, 'src', 'order.json'), 'utf-8'));
const watch = process.argv.includes('--watch');

function build() {
  const out = [];
  for (const rel of order) {
    const file = path.join(root, 'src', rel);
    const { code } = esbuild.transformSync(fs.readFileSync(file, 'utf-8'), {
      loader: 'ts', target: 'chrome124', sourcefile: 'src/' + rel, sourcemap: false, charset: 'utf8',
    });
    out.push(`// ---- ${rel} ----\n${code}`);
  }
  const dist = path.join(root, 'renderer', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'renderer.js'), out.join('\n'));
  esbuild.buildSync({ entryPoints: [path.join(root, 'src', 'vendor', 'emmet-entry.js')], bundle: true, format: 'iife', minify: true, target: 'chrome124', outfile: path.join(dist, 'emmet.js'), logLevel: 'error' });
  console.log(`[build] ${order.length} modules -> renderer/dist/renderer.js (+ emmet.js)`);
}
build();
if (watch) {
  fs.watch(path.join(root, 'src'), { recursive: true }, () => { try { build(); } catch (e) { console.error(e.message); } });
}
