const { test, expect } = require('@playwright/test');
const { launch, makeProject } = require('./helpers');
const fs = require('fs'); const path = require('path');

test('extension runs sandboxed: command, status item, fs scope, no network', async () => {
  const { app, page, userData } = await launch();
  const dir = path.join(userData, 'extensions', 'demo'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', main: 'main.js', commands: [{ id: 'go', title: 'Go' }] }));
  fs.writeFileSync(path.join(dir, 'main.js'), `
nexo.statusBar.set('DEMO-ON');
nexo.commands.register('go', async () => {
  const out = {};
  out.hasFetch = typeof fetch; out.hasRequire = typeof require; out.hasBridge = typeof self.nexo.workspace === 'object' && typeof window;
  try { await nexo.workspace.readFile('/etc/passwd'); out.escape = 'LEAK'; } catch (e) { out.escape = 'blocked'; }
  await nexo.workspace.writeFile((await nexo.workspace.roots())[0] + '/ext-out.json', JSON.stringify(out));
});`);
  const proj = makeProject({ 'a.txt': 'x' });
  await page.evaluate((p) => openProject(p), proj);
  await page.evaluate(() => window.nexoExtensions.reload());
  await expect(page.locator('.ext-status')).toHaveText('DEMO-ON');
  await page.evaluate(() => PALETTE_COMMANDS.find((c) => c.label === 'Demo: Go').run());
  await expect.poll(() => fs.existsSync(path.join(proj, 'ext-out.json'))).toBeTruthy();
  const out = JSON.parse(fs.readFileSync(path.join(proj, 'ext-out.json'), 'utf8'));
  expect(out).toMatchObject({ hasFetch: 'undefined', hasRequire: 'undefined', escape: 'blocked' });
  // disable removes it
  await page.evaluate(() => window.nexo.extSetEnabled('demo', false).then(() => window.nexoExtensions.reload()));
  await expect(page.locator('.ext-status')).toHaveCount(0);
  await page.evaluate(() => { state.tabs && state.tabs.forEach((t) => (t.modified = false)); });
  await app.close();
});
