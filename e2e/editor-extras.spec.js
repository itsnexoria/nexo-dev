const { test, expect } = require('@playwright/test');
const { launch, makeProject } = require('./helpers');

const clean = (page) => page.evaluate(() => { (state.openTabs || []).forEach((t) => (t.modified = false)); });

test('bookmarks: toggle, navigate, follow edits, clear', async () => {
  const proj = makeProject({ 'a.txt': 'l1\nl2\nl3\nl4\nl5\n' });
  const { app, page, cspViolations } = await launch();
  await page.evaluate(async (p) => { await openProject(p); await openFile(p + '/a.txt'); }, proj);
  const at = (n) => page.evaluate((l) => { editor.setPosition({ lineNumber: l, column: 1 }); nexoBookmarks.toggle(); }, n);
  await at(2); await at(4);
  expect(await page.evaluate(() => nexoBookmarks.lines())).toEqual([2, 4]);
  await page.evaluate(() => { editor.setPosition({ lineNumber: 1, column: 1 }); nexoBookmarks.next(); });
  expect(await page.evaluate(() => editor.getPosition().lineNumber)).toBe(2);
  await page.evaluate(() => nexoBookmarks.next());
  expect(await page.evaluate(() => editor.getPosition().lineNumber)).toBe(4);
  await page.evaluate(() => nexoBookmarks.next()); // wraps
  expect(await page.evaluate(() => editor.getPosition().lineNumber)).toBe(2);
  await page.evaluate(() => nexoBookmarks.prev()); // wraps back
  expect(await page.evaluate(() => editor.getPosition().lineNumber)).toBe(4);
  await page.evaluate(() => editor.executeEdits('t', [{ range: new monaco.Range(1, 1, 1, 1), text: 'new\n' }]));
  expect(await page.evaluate(() => nexoBookmarks.lines())).toEqual([3, 5]);
  await at(3);
  expect(await page.evaluate(() => nexoBookmarks.lines())).toEqual([5]);
  await page.evaluate(() => nexoBookmarks.clear());
  expect(await page.evaluate(() => nexoBookmarks.lines())).toEqual([]);
  await clean(page); await app.close();
  expect(cspViolations).toEqual([]);
});

test('emmet: html and css abbreviations appear as completions; fold presets exist', async () => {
  const proj = makeProject({ 'a.html': '<div>\nul>li*2\n</div>\n', 'a.css': 'a {\n  m10\n}\n' });
  const { app, page, cspViolations } = await launch();
  await page.evaluate(async (p) => { await openProject(p); await openFile(p + '/a.html'); }, proj);
  const items = (line, col) => page.evaluate(async ([ln, c]) => {
    editor.setPosition({ lineNumber: ln, column: c });
    editor.focus();
    editor.trigger('t', 'editor.action.triggerSuggest', {});
    await new Promise((r) => setTimeout(r, 600));
    const w = document.querySelectorAll('.suggest-widget .monaco-list-row');
    return [...w].map((x) => x.getAttribute('aria-label') || x.textContent);
  }, [line, col]);
  const html = await items(2, 8);
  expect(html.join('|')).toContain('ul>li*2');
  await page.evaluate(async (p) => { await openFile(p + '/a.css'); }, proj);
  const css = await items(2, 6);
  expect(css.join('|')).toContain('m10');
  const foldIds = await page.evaluate(() => ['editor.foldLevel1', 'editor.foldAllBlockComments', 'editor.foldAllMarkerRegions', 'editor.unfoldAllMarkerRegions', 'editor.toggleFold'].map((id) => !!editor.getAction(id)));
  expect(foldIds).toEqual([true, true, true, true, true]);
  await clean(page); await app.close();
  expect(cspViolations).toEqual([]);
});
