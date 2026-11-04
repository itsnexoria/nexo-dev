const { test, expect } = require('@playwright/test');
const { launch, makeProject } = require('./helpers');
const http = require('http');
const path = require('path');
const fs = require('fs');

test('live server starts, serves project, stops', async () => {
  const proj = makeProject({ 'index.html': '<body>LIVE-OK</body>' });
  const { app, page } = await launch();
  const res = await page.evaluate((p) => window.nexo.liveStart(p), proj);
  expect(res.ok).toBeTruthy();
  const text = await new Promise((r) => http.get(res.url, { agent: false }, (x) => { let b = ''; x.on('data', (d) => b += d); x.on('end', () => r(b)); }));
  expect(text).toContain('LIVE-OK'); expect(text).toContain('__nexo_live');
  await page.evaluate(() => window.nexo.liveStop());
  await app.close();
});

test('http client panel sends a request', async () => {
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end('{"hello":"world"}'); }).listen(0);
  const { app, page } = await launch();
  await page.click('#rail-http');
  await page.fill('#http-url', `http://127.0.0.1:${srv.address().port}/x`);
  await page.click('#http-send');
  await expect(page.locator('#http-meta')).toContainText('200');
  await expect(page.locator('#http-res-body')).toContainText('"hello": "world"');
  srv.close(); await app.close();
});

test('database viewer lists tables and runs read-only queries', async () => {
  const initSqlJs = require('sql.js'); const SQL = await initSqlJs();
  const d = new SQL.Database(); d.run('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users(name) VALUES ("ada"),("grace");');
  const proj = makeProject(); const file = path.join(proj, 'app.sqlite'); fs.writeFileSync(file, Buffer.from(d.export()));
  const { app, page } = await launch();
  await page.click('#rail-data');
  await page.evaluate((f) => window.nexoOpenDatabase(f), file);
  await expect(page.locator('.db-table')).toContainText('users');
  await expect(page.locator('.db-grid')).toContainText('grace');
  await page.fill('#db-sql', 'SELECT COUNT(*) AS n FROM users');
  await page.click('#db-run');
  await expect(page.locator('.db-grid')).toContainText('2');
  await app.close();
});

test('database manager: opt in to writes, edit a cell, save, export grid is read-only before opt-in', async () => {
  const initSqlJs = require('sql.js'); const SQL = await initSqlJs();
  const d = new SQL.Database(); d.run('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users(name) VALUES ("ada"),("grace");');
  const proj = makeProject(); const file = path.join(proj, 'edit.sqlite'); fs.writeFileSync(file, Buffer.from(d.export()));
  const { app, page } = await launch();
  await page.click('#rail-data');
  await page.evaluate((f) => window.nexoOpenDatabase(f), file);
  await expect(page.locator('.db-grid')).toContainText('grace');
  expect(await page.locator('.db-grid td.editable').count()).toBe(0);           // read-only by default
  await page.fill('#db-sql', 'DELETE FROM users');
  await page.click('#db-run');
  await expect(page.locator('.db-error')).toContainText('Read-only');
  page.once('dialog', (dlg) => dlg.accept());
  await page.check('#db-allow-writes');
  await expect(page.locator('.db-grid td.editable').first()).toBeVisible();
  await page.locator('.db-grid td.editable', { hasText: 'ada' }).dblclick();
  await page.locator('.db-cell-input').fill('lovelace');
  await page.keyboard.press('Enter');
  await expect(page.locator('#db-save')).toBeVisible();
  await page.click('#db-save');
  await expect(page.locator('#db-save')).toBeHidden();
  const SQL2 = await initSqlJs();
  const back = new SQL2.Database(fs.readFileSync(file));
  expect(back.exec('SELECT name FROM users WHERE id=1')[0].values[0][0]).toBe('lovelace');
  await app.close();
});

test('http client: environments, cURL import, saved collection persists', async () => {
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ path: q.url, tok: q.headers['x-t'] || null })); }).listen(0);
  const port = srv.address().port;
  const { app, page, userData } = await launch();
  await page.click('#rail-http');
  await page.click('#http-env-new');
  await page.fill('#modal-field-name', 'Local'); await page.click('#modal-confirm');
  await page.fill('#modal-field-vars', `host=127.0.0.1:${port};tok=s3cret`); await page.click('#modal-confirm');
  await page.fill('#http-url', 'http://{{host}}/items');
  await page.fill('#http-headers', 'X-T: {{tok}}');
  await page.click('#http-send');
  await expect(page.locator('#http-res-body')).toContainText('"tok": "s3cret"');
  await expect(page.locator('#http-res-body')).toContainText('/items');
  // unresolved variables are reported
  await page.fill('#http-url', `http://127.0.0.1:${port}/{{missing}}`);
  await page.click('#http-send');
  await expect(page.locator('#http-meta')).toContainText('{{missing}}');
  // cURL import
  await page.click('#http-import-curl');
  await page.fill('#modal-field-cmd', `curl -X PUT 'http://127.0.0.1:${port}/put' -H 'X-T: abc' -d 'hello'`); await page.click('#modal-confirm');
  await expect(page.locator('#http-method')).toHaveValue('PUT');
  await expect(page.locator('#http-headers')).toHaveValue(/^X-T: abc/);
  // collection: create folder, save request, survives a reload of the store
  await page.click('#http-folder-new');
  await page.fill('#modal-field-name', 'API'); await page.click('#modal-confirm');
  await page.getByText('Save here').click();
  await page.fill('#modal-field-name', 'put it'); await page.click('#modal-confirm');
  await expect(page.locator('.http-hist-item', { hasText: 'put it' })).toBeVisible();
  await page.waitForTimeout(600);
  const stored = JSON.parse(fs.readFileSync(path.join(userData, 'http-client.json'), 'utf-8'));
  expect(stored.folders[0].requests[0].name).toBe('put it');
  expect(stored.envs[0].vars.tok).toBe('s3cret');
  srv.close(); await app.close();
});
