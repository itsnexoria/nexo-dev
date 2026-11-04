const { test, expect } = require('@playwright/test');
const { launch, makeProject } = require('./helpers');
const fs = require('fs'); const path = require('path');
const clean = (page) => page.evaluate(() => { (state.openTabs || []).forEach((t) => (t.modified = false)); });

test('search and replace across files', async () => {
  const proj = makeProject({ 'a.txt': 'foo bar foo', 'sub/b.txt': 'foo' });
  const { app, page } = await launch();
  await page.evaluate((p) => openProject(p), proj);
  await page.click('#rail-search');
  await page.fill('#search-input', 'foo');
  await expect(page.locator('#search-results')).toContainText('a.txt');
  const r = await page.evaluate(([root]) => window.nexo.replaceAll(root, 'foo', 'baz', { caseSensitive: false, regex: false }), [proj]);
  expect(r.ok !== false).toBeTruthy();
  { expect(fs.readFileSync(path.join(proj, 'a.txt'), 'utf8')).toBe('baz bar baz'); expect(fs.readFileSync(path.join(proj, 'sub/b.txt'), 'utf8')).toBe('baz'); }
  await clean(page); await app.close();
});

test('session restore reopens tabs after relaunch', async () => {
  const proj = makeProject({ 'keep.txt': 'hello' });
  const first = await launch();
  await first.page.evaluate((p) => openProject(p), proj);
  await first.page.evaluate((f) => openFile(f), path.join(proj, 'keep.txt'));
  await first.page.waitForFunction(() => state.openTabs.length === 1);
  await first.page.evaluate(() => window.nexo.saveSession(state.projectRoot, { tabs: state.openTabs.map((t) => t.path), active: state.activeTab }));
  await new Promise((r) => setTimeout(r, 600));
  await clean(first.page); await first.app.close();
  const second = await launch({}, first.userData);
  const sess = await second.page.evaluate((p) => window.nexo.loadSession(p), proj);
  expect(JSON.stringify(sess)).toContain('keep.txt');
  await second.app.close();
});

test('a11y: tree and tabs expose roles and arrow-key navigation', async () => {
  const proj = makeProject({ 'a.txt': 'a', 'b.txt': 'b' });
  const { app, page } = await launch();
  await page.evaluate((p) => openProject(p), proj);
  await expect(page.locator('#file-tree[role=tree] .tree-row[role=treeitem]').first()).toBeVisible();
  const first = page.locator('.tree-row[tabindex="0"]').first();
  await first.focus(); await page.keyboard.press('ArrowDown');
  const focused = await page.evaluate(() => document.activeElement.classList.contains('tree-row'));
  expect(focused).toBe(true);
  await page.evaluate((f) => openFile(f), path.join(proj, 'a.txt'));
  await expect(page.locator('#tabbar[role=tablist] .tab[role=tab][aria-selected=true]')).toHaveCount(1);
  await clean(page); await app.close();
});

test('first-run tour shows once and can be skipped', async () => {
  const { app, page } = await launch();
  await expect(page.locator('#tour-card')).toBeVisible({ timeout: 5000 });
  await page.click('#tour-next');
  await page.click('#tour-skip');
  await expect(page.locator('#tour-card')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('nexo.tourDone'))).toBe('1');
  await app.close();
});
