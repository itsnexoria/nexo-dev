const { test, expect } = require('@playwright/test');
const { launch } = require('./helpers');

test('rebind, swallow default, persist, conflicts', async () => {
  const { app, page } = await launch();
  await page.evaluate(() => { window.__toggled = 0; });
  // rebind sidebar toggle Ctrl+B -> Ctrl+Alt+J
  const ok = await page.evaluate(() => window.nexoKeybindings.setBinding('view.sidebar', 'Ctrl+Alt+J'));
  expect(ok).toBe(true);
  const disp = () => page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).display);
  const before = await disp();
  await page.keyboard.press('Control+b'); // old default must be swallowed
  expect(await disp()).toBe(before);
  await page.keyboard.press('Control+Alt+j');
  expect(await disp()).toBe('none');
  // dialog: opens, searchable, conflict flagged
  await page.evaluate(() => window.nexoKeybindings.setBinding('view.terminal', 'Ctrl+Alt+J'));
  await page.evaluate(() => window.nexoKeybindings.openDialog());
  await page.fill('#kb-search', 'toggle sidebar');
  await expect(page.locator('#kb-list')).toContainText('conflict');
  await page.click('#kb-close');
  await expect(page.locator('#kb-dialog')).toHaveCount(0);
  // persisted through prefs
  const saved = await page.evaluate(async () => { await new Promise(r => setTimeout(r, 200)); return (await window.nexo.getPrefs()).keybindings; });
  expect(saved['view.sidebar']).toBe('Ctrl+Alt+J');
  await page.evaluate(() => { state.tabs && state.tabs.forEach((t) => (t.modified = false)); });
  await app.close();
});
