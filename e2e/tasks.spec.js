const { test, expect } = require('@playwright/test');
const { launch, makeProject } = require('./helpers');

test('tasks runner parses output into the Problems panel; trust + bookmarks APIs work', async () => {
  const { app, page } = await launch();
  const proj = makeProject({
    'a.js': 'var x = 1;\nvar y = 2;\n',
    'package.json': JSON.stringify({ name: 't', scripts: { lint: "node -e \"console.log('a.js:2:5: error: boom')\"" } }),
  });
  await page.evaluate((p) => openProject(p), proj);
  const tasks = await page.evaluate(() => window.nexoTasks.load());
  expect(tasks.map((t) => t.label)).toContain('lint');
  await page.evaluate(() => window.nexoTasks.run(window.nexoTasks.state.tasks.find((t) => t.label === 'lint')));
  await expect.poll(() => page.evaluate(() => window.nexoTasks.problems().length)).toBe(1);
  await expect(page.locator('#problems-list .problem-row')).toHaveCount(1);
  await expect(page.locator('#status-problems')).toContainText('⊗ 1');
  expect((await page.evaluate((p) => window.nexo.trustStatus(p), proj)).trusted).toBe(true); // NEXO_E2E trusts everything
  const saved = await page.evaluate(async (p) => { await window.nexo.bookmarksSave(p, { [p + '/a.js']: [2, 2, -1] }); return (await window.nexo.bookmarksLoad(p)).files; }, proj);
  expect(saved[proj + '/a.js']).toEqual([2]);
  await page.evaluate(() => { state.tabs && state.tabs.forEach((t) => (t.modified = false)); });
  await app.close();
});
