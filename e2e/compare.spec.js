const { test, expect } = require('@playwright/test');
const { launch, makeProject } = require('./helpers');

test('compare: active file vs another open file', async () => {
  const proj = makeProject({ 'a.txt': 'one\ntwo\n', 'b.txt': 'one\nthree\n' });
  const { app, page, cspViolations } = await launch();
  await page.evaluate(async (p) => { await openProject(p); await openFile(p + '/a.txt'); await openFile(p + '/b.txt'); await openFile(p + '/a.txt'); }, proj);
  await page.keyboard.press('Control+Shift+P');
  await page.fill('#palette-input', '>compare active file with…');
  await page.keyboard.press('Enter');
  await expect(page.locator('#compare-overlay')).toBeVisible();
  await expect(page.locator('.compare-title')).toContainText('a.txt');
  await expect(page.locator('#compare-host .monaco-diff-editor')).toBeVisible();
  const texts = await page.evaluate(() => { return monaco.editor.getModels().map((x) => x.getValue()); });
  expect(texts).toContain('one\nthree\n');
  await page.keyboard.press('Escape');
  await expect(page.locator('#compare-overlay')).toHaveCount(0);
  await app.close();
  expect(cspViolations).toEqual([]);
});
