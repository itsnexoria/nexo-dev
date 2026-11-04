const { test, expect } = require('@playwright/test');
const { launch, makeProject } = require('./helpers');

test('PTY terminal: interactive shell, split panes, panel-launched commands', async () => {
  const proj = makeProject({ 'package.json': '{"name":"t","scripts":{"hi":"echo SCRIPT-RAN-$((1+1))"}}' });
  const { app, page } = await launch({ SHELL: '/bin/sh' });
  await page.evaluate((p) => openProject(p), proj);
  await page.waitForFunction(() => window.__ptyReady === true);
  await page.keyboard.press('Control+`');
  await expect(page.locator('#terminal-panel')).toHaveClass(/pty-mode/);
  await expect(page.locator('.pty-pane .xterm')).toHaveCount(1);
  await page.locator('.pty-pane .xterm-helper-textarea').first().focus();
  await page.keyboard.type('echo nexo-$((6*7))');
  await page.keyboard.press('Enter');
  await expect(page.locator('.pty-pane .xterm-rows')).toContainText('nexo-42');
  // runs in the project dir
  await page.keyboard.type('pwd'); await page.keyboard.press('Enter');
  await expect(page.locator('.pty-pane .xterm-rows')).toContainText(proj.split('/').pop());
  // split
  await page.click('#term-split-h');
  await expect(page.locator('.pty-pane')).toHaveCount(2);
  await page.locator('.pty-pane').nth(1).locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo second-pane'); await page.keyboard.press('Enter');
  await expect(page.locator('.pty-pane').nth(1).locator('.xterm-rows')).toContainText('second-pane');
  // panel-driven command (npm script path)
  await page.evaluate(() => runCommandInTerminal('echo SCRIPT-RAN-$((1+1))'));
  await expect(page.locator('.pty-pane .xterm-rows').nth(1)).toContainText('SCRIPT-RAN-2');
  // close pane
  await page.click('#term-close-pane');
  await expect(page.locator('.pty-pane')).toHaveCount(1);
  await app.close();
});
