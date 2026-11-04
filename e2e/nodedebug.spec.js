const { test, expect } = require('@playwright/test');
const { launch, makeProject } = require('./helpers');

test('node debugger: breakpoint pause, variables, continue to exit', async () => {
  test.setTimeout(90000);
  const proj = makeProject({ 'app.js': 'let total = 0;\nfor (let i = 1; i <= 3; i++) {\n  total += i;\n}\nconsole.log("done", total);\n' });
  const { app, page } = await launch();
  await page.evaluate((p) => openProject(p), proj);
  await page.evaluate((p) => openFile(p + '/app.js'), proj);
  await page.evaluate((p) => toggleBreakpoint(p + '/app.js', 3), proj);
  await page.evaluate(() => startDebug && startDebug());
  await page.waitForFunction(() => dbg.active && dbg.stopped, null, { timeout: 30000 });
  const line = await page.evaluate(() => dbg.frames[0] && (dbg.frames[0].line || dbg.frames[0].lineNumber));
  expect(line).toBe(3);
  const names = await page.evaluate(() => JSON.stringify(dbg.variables));
  expect(names).toContain('total');
  for (let i = 0; i < 3; i++) {
    await page.waitForFunction(() => !dbg.active || dbg.stopped, null, { timeout: 30000 });
    if (!(await page.evaluate(() => dbg.active))) break;
    await page.evaluate(() => dbgControl('continue'));
    await page.waitForTimeout(300);
  }
  await page.waitForFunction(() => !dbg.active, null, { timeout: 30000 });
  await app.close();
});
