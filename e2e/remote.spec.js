const { test, expect } = require('@playwright/test');
const { launch } = require('./helpers');

test('remote terminals: invalid targets are rejected by the main process; palette commands registered', async () => {
  const { app, page, cspViolations } = await launch();
  const spawn = (remote) => page.evaluate((r) => window.nexo.ptySpawn({ cols: 80, rows: 24, remote: r }), remote);
  expect((await spawn({ kind: 'ssh', target: '-oProxyCommand=evil' })).error).toMatch(/Invalid SSH host/);
  expect((await spawn({ kind: 'docker', container: '--privileged' })).error).toMatch(/container/);
  expect((await spawn({ kind: 'devcontainer', folder: '/etc' })).error).toMatch(/outside the open workspace/);
  const palette = await page.evaluate(() => PALETTE_COMMANDS.filter((c) => c.label.startsWith('Remote:')).map((c) => c.label));
  expect(palette).toHaveLength(3);
  const hosts = await page.evaluate(() => window.nexo.remoteSshHosts());
  expect(hosts.ok).toBe(true);
  await app.close();
  expect(cspViolations).toEqual([]);
});
