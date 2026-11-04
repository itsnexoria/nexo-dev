const { test, expect } = require('@playwright/test');
const { launch, makeProject } = require('./helpers');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf-8' });

test('git: stage a hunk, side-by-side diff, stash, commit graph', async () => {
  test.setTimeout(90000);
  const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
  const proj = makeProject({ 'f.txt': lines.join('\n') + '\n' });
  sh(proj, 'init', '-q', '-b', 'main'); sh(proj, 'config', 'user.email', 't@t'); sh(proj, 'config', 'user.name', 't');
  sh(proj, 'add', '.'); sh(proj, 'commit', '-qm', 'init');
  const edited = lines.slice(); edited[2] = 'EDIT-A'; edited[35] = 'EDIT-B';
  fs.writeFileSync(path.join(proj, 'f.txt'), edited.join('\n') + '\n');

  const { app, page } = await launch();
  await page.evaluate((p) => openProject(p), proj);
  await page.evaluate(() => switchRailView('git'));
  await page.waitForSelector('.git-file-row');
  await page.evaluate(() => showDiff('f.txt', false));
  await expect(page.locator('.hunk-head')).toHaveCount(2);

  // stage only the first hunk
  await page.locator('.hunk-head').first().getByText('Stage hunk').click();
  await page.waitForFunction(() => gitState.staged.length === 1 && gitState.unstaged.length === 1);
  expect(sh(proj, 'diff', '--cached')).toContain('EDIT-A');
  expect(sh(proj, 'diff', '--cached')).not.toContain('EDIT-B');

  // side by side shows a Monaco diff editor
  await page.getByText('Side by side').click();
  await page.waitForSelector('.sbs-host .monaco-diff-editor');

  // stash + graph
  await page.evaluate(() => { localStorage.setItem('nexo.gitDiffMode', 'inline'); });
  const r = await page.evaluate((p) => window.nexo.gitStashPush(p, 'wip', false), proj);
  expect(r.ok).toBe(true);
  await page.evaluate(() => renderGitPanel());
  await expect(page.locator('#git-stash-section .stash-row')).toHaveCount(1);
  sh(proj, 'stash', 'pop');
  sh(proj, 'checkout', '-qb', 'feat'); fs.writeFileSync(path.join(proj, 'g.txt'), 'g'); sh(proj, 'add', 'g.txt'); sh(proj, 'commit', '-qm', 'feat commit');
  await page.evaluate(() => { document.getElementById('git-tab-history').click(); });
  await page.waitForSelector('.graph-row svg');
  expect(await page.locator('.graph-row').count()).toBeGreaterThanOrEqual(2);
  await app.close();
});
