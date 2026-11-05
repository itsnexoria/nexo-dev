const { test, expect } = require('@playwright/test');
const { launch } = require('./helpers');

test('theme presets: import adds chips, bad files are rejected', async () => {
  const { app, page, cspViolations } = await launch();
  const good = JSON.stringify({ format: 'nexo-theme-presets', version: 1, presets: [{ name: 'Ocean', bg: '#001122', text: '#ffffff', accent: '#00aaff' }] });
  const added = await page.evaluate((t) => { const a = NexoThemePresets.parse(t); uiState.customThemes = [...uiState.customThemes, ...a]; return a.length; }, good);
  expect(added).toBe(1);
  await page.evaluate(() => switchRailView('settings'));
  await expect(page.locator('.preset-chip', { hasText: 'Ocean' })).toBeVisible();
  const err = await page.evaluate(() => { try { NexoThemePresets.parse('{}'); return ''; } catch (e) { return e.message; } });
  expect(err).toMatch(/Nexo theme preset/);
  await app.close();
  expect(cspViolations).toEqual([]);
});
