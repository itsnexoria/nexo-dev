const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

async function launch(extraEnv = {}, existingUserData) {
  const userData = existingUserData || fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-ud-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), '--no-sandbox', `--user-data-dir=${userData}`],
    env: { ...process.env, NEXO_E2E: '1', ...extraEnv },
  });
  const cspViolations = [];
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    page = app.windows().find((w) => w.url().includes('index.html')) || null;
    if (!page) await new Promise((r) => setTimeout(r, 200));
  }
  if (!page) throw new Error('main window not found');
  page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) cspViolations.push(m.text()); });
  await page.waitForSelector('#activitybar');
  // DOM appears before the scripts finish: wait for the renderer to be fully booted.
  await page.waitForFunction(() => typeof uiState !== 'undefined' && typeof openProject === 'function' && !!window.monaco && !!window.nexo, null, { timeout: 30000 });
  return { app, page, userData, cspViolations };
}

function makeProject(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-proj-'));
  for (const [rel, content] of Object.entries({ 'index.html': '<h1>hi</h1>', 'README.md': '# T', ...files })) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}
module.exports = { launch, makeProject };
