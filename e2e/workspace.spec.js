const { test, expect } = require('@playwright/test');
const { launch, makeProject } = require('./helpers');
const path = require('path');
const fs = require('fs');

test('multi-root workspace: add folder and save', async () => {
  const a = makeProject({ 'a-only.txt': 'a' });
  const b = makeProject({ 'b-only.txt': 'b' });
  const { app, page } = await launch();
  await page.evaluate((p) => openProject(p), a);
  await page.evaluate((p) => nexoWorkspace.addFolder(p), b);
  await expect(page.locator('#project-name')).toContainText('Workspace');
  expect(await page.evaluate(() => state.roots.length)).toBe(2);
  // both roots' files are reachable from the single tree
  await page.evaluate(async (p) => { state.expanded.add(p); await renderTree(); }, a);
  await expect(page.locator('.tree-row .name', { hasText: 'b-only.txt' }).or(page.locator('.tree-row .name', { hasText: path.basename(b) }))).toBeVisible();

  const wsFile = path.join(a, 'test.nexo-workspace');
  await page.evaluate(async (f) => { state.workspaceFile = f; await nexoWorkspace.saveWorkspace(); }, wsFile);
  const saved = JSON.parse(fs.readFileSync(wsFile, 'utf-8'));
  expect(saved.folders).toHaveLength(2);
  expect(saved.folders.some((f) => f.path === b)).toBe(true);
  await app.close();
});
