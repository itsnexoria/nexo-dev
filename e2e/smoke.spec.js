const { test, expect } = require('@playwright/test');
const { launch } = require('./helpers');

test('app boots and shows welcome', async () => {
  const { app, page } = await launch();
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('.rail-btn')).toHaveCount(12);
  await app.close();
});

test('IPC filesystem scope: paths outside the workspace are refused', async () => {
  const { app, page } = await launch();
  const r = await page.evaluate(() => window.nexo.readFile('/etc/hosts'));
  expect(r.ok).toBe(false);
  expect(r.code).toBe('EOUTSCOPE');
  const w = await page.evaluate(() => window.nexo.writeFile('/etc/nexo-test', 'x'));
  expect(w.ok).toBe(false);
  await app.close();
});

test('no CSP violations while opening a project and a file', async () => {
  const { makeProject } = require('./helpers');
  const proj = makeProject({ 'a.js': 'const x = 1;\n' });
  const { app, page, cspViolations } = await launch();
  await page.evaluate((p) => openProject(p), proj);
  await page.evaluate((p) => openFile(p + '/a.js'), proj);
  await page.waitForFunction(() => document.querySelector('.monaco-editor'));
  await page.waitForTimeout(1500);
  expect(cspViolations).toEqual([]);
  await app.close();
});
