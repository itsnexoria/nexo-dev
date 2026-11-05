const { test, expect } = require('@playwright/test');
const { launch, makeProject } = require('./helpers');

async function run(page, label) {
  await page.evaluate((l) => PALETTE_COMMANDS.find((c) => c.label === l).run(), label);
}
const text = (page) => page.evaluate(() => editor.getModel().getValue());

test('editor actions: line transforms, case, view toggles', async () => {
  const proj = makeProject({ 'a.txt': 'pear\napple\n\npear\nfig' });
  const { app, page, cspViolations } = await launch();
  await page.evaluate(async (p) => { await openProject(p); await openFile(p + '/a.txt'); }, proj);
  await run(page, 'Lines: Remove Empty');
  expect(await text(page)).toBe('pear\napple\npear\nfig');
  await run(page, 'Lines: Remove Duplicates');
  expect(await text(page)).toBe('pear\napple\nfig');
  await run(page, 'Lines: Reverse');
  expect(await text(page)).toBe('fig\napple\npear');
  await run(page, 'Lines: Sort Ascending');
  expect(await text(page)).toBe('apple\nfig\npear');
  await page.evaluate(() => { editor.setSelection(new monaco.Selection(1, 1, 1, 6)); });
  await run(page, 'Transform: Uppercase');
  expect(await text(page)).toBe('APPLE\nfig\npear');
  const before = await page.evaluate(() => uiState.wordWrap);
  await run(page, 'View: Toggle Word Wrap');
  expect(await page.evaluate(() => uiState.wordWrap)).toBe(!before);
  expect(await page.evaluate(() => editor.getOption(monaco.editor.EditorOption.wrappingInfo).isViewportWrapping || editor.getRawOptions().wordWrap)).toBeTruthy();
  await page.evaluate(() => { (state.openTabs || []).forEach((t) => (t.modified = false)); });
  await app.close();
  expect(cspViolations).toEqual([]);
});
