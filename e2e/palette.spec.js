const { test, expect } = require('@playwright/test');
const { launch, makeProject } = require('./helpers');

test('command palette: opens, ranks and runs a command', async () => {
  const { app, page } = await launch();
  await page.keyboard.press('Control+Shift+P');
  await expect(page.locator('#palette-overlay')).toBeVisible();
  await page.fill('#palette-input', '>tgl term');
  await expect(page.locator('.palette-item').first()).toContainText('Toggle Terminal');
  await page.keyboard.press('Enter');
  await expect(page.locator('#palette-overlay')).toBeHidden();
  await expect(page.locator('#terminal-panel')).toHaveClass(/active/);
  await app.close();
});
