const { test, expect } = require('@playwright/test');
const { launch, makeProject } = require('./helpers');
const path = require('path');

test('LSP: diagnostics, completion & go-to-definition via a real typescript-language-server', async () => {
  test.setTimeout(120000);
  const proj = makeProject({
    'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"es2020","module":"commonjs"}}',
    'a.ts': 'export function greet(name: string): string { return "hi " + name; }\n',
    'b.ts': 'import { greet } from "./a";\nconst n: number = greet("x");\ngre\n',
  });
  const { app, page } = await launch();
  const cfg = { command: path.join(__dirname, '..', 'node_modules', '.bin', 'typescript-language-server'), args: ['--stdio'] };
  await page.evaluate(async (c) => { await window.nexo.setPrefs({ lspServers: { typescript: c, javascript: c } }); uiState.lspServers = { typescript: c, javascript: c }; }, cfg);
  await page.evaluate((p) => openProject(p), proj);
  await page.waitForFunction(() => window.__lspReady === true, null, { timeout: 60000 });
  await page.evaluate((p) => openFile(p + '/b.ts'), proj);

  // diagnostics from the server (type error on line 2)
  await page.waitForFunction(() => monaco.editor.getModelMarkers({ owner: 'lsp' }).some((m) => /not assignable/.test(m.message)), null, { timeout: 60000 });
  await expect(page.locator('#status-lsp')).toContainText('typescript-language-server');

  // completion: ask the provider through Monaco for suggestions at "gre|" on line 3
  const labels = await page.evaluate(async () => {
    editor.setPosition({ lineNumber: 3, column: 4 });
    editor.focus();
    editor.trigger('test', 'editor.action.triggerSuggest', {});
    await new Promise((r) => setTimeout(r, 2500));
    const w = document.querySelector('.suggest-widget');
    return w ? w.innerText : '';
  });
  expect(labels).toContain('greet');

  // go to definition opens a.ts in a tab
  await page.evaluate(() => { editor.setPosition({ lineNumber: 2, column: 22 }); editor.focus(); nexoGoToDefinition(editor); });
  await page.waitForFunction(() => state.activeTab && state.activeTab.endsWith('a.ts'), null, { timeout: 20000 });
  await app.close();
});

test('LSP: missing server degrades gracefully', async () => {
  const proj = makeProject({ 'main.go': 'package main\n' });
  const { app, page } = await launch();
  await page.evaluate(async () => { await window.nexo.setPrefs({ lspServers: { go: { command: 'no-such-gopls-xyz', args: [] } } }); });
  await page.evaluate((p) => openProject(p), proj);
  await page.waitForFunction(() => window.__lspReady === true, null, { timeout: 60000 });
  await page.evaluate((p) => openFile(p + '/main.go'), proj);
  await expect(page.locator('#status-lsp')).toContainText('no server', { timeout: 15000 });
  await app.close();
});

test('LSP: rename across files, quick fixes, status dialog', async () => {
  test.setTimeout(120000);
  const proj = makeProject({
    'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"es2020","module":"commonjs"}}',
    'a.ts': 'export function greet(name: string): string { return "hi " + name; }\n',
    'b.ts': 'import { greet } from "./a";\nconsole.log(greet("x"));\nconst q = gret("y");\n',
  });
  const { app, page } = await launch();
  const cfg = { command: path.join(__dirname, '..', 'node_modules', '.bin', 'typescript-language-server'), args: ['--stdio'] };
  await page.evaluate(async (c) => { await window.nexo.setPrefs({ lspServers: { typescript: c, javascript: c } }); uiState.lspServers = { typescript: c, javascript: c }; }, cfg);
  await page.evaluate((p) => openProject(p), proj);
  await page.waitForFunction(() => window.__lspReady === true, null, { timeout: 60000 });
  await page.evaluate((p) => openFile(p + '/b.ts'), proj);
  await page.waitForFunction(() => monaco.editor.getModelMarkers({ owner: 'lsp' }).some((m) => /Did you mean|Cannot find name/.test(m.message)), null, { timeout: 60000 });

  // quick fix: ask Monaco for code actions on the misspelled identifier
  const titles = await page.evaluate(async () => {
    const model = editor.getModel();
    const range = new monaco.Range(3, 11, 3, 15);
    const markers = monaco.editor.getModelMarkers({ resource: model.uri });
    const actions = await monaco.languages.getCodeActions ? [] : [];
    return markers.map((m) => m.message);
  });
  expect(titles.join(' ')).toMatch(/gret/);
  const fixes = await page.evaluate(async () => {
    editor.setPosition({ lineNumber: 3, column: 12 }); editor.focus();
    const c = [...window.__lsp.clients.values()][0];
    const path = state.activeTab;
    const r = await c.request('textDocument/codeAction', { textDocument: { uri: monaco.Uri.file(path).toString() }, range: { start: { line: 2, character: 10 }, end: { line: 2, character: 14 } }, context: { diagnostics: monaco.editor.getModelMarkers({ owner: 'lsp' }).map((m) => ({ range: { start: { line: m.startLineNumber - 1, character: m.startColumn - 1 }, end: { line: m.endLineNumber - 1, character: m.endColumn - 1 } }, message: m.message, code: m.code && m.code.value ? m.code.value : m.code })) } }, 15000);
    return (r || []).map((a) => a.title);
  });
  expect(fixes.join(' ')).toMatch(/greet/);

  // rename greet -> hello; both files change
  await page.evaluate((p) => openFile(p + '/a.ts'), proj);
  await page.waitForFunction(() => state.activeTab && state.activeTab.endsWith('a.ts') && editor.getModel().getValue().includes('greet'), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { editor.setPosition({ lineNumber: 1, column: 20 }); editor.focus(); editor.trigger('t', 'editor.action.rename', {}); });
  await page.waitForSelector('.rename-input', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+A'); await page.keyboard.type('hello'); await page.keyboard.press('Enter');
  let bText = '';
  for (let i = 0; i < 40; i++) {
    bText = await page.evaluate(() => (state.openTabs.find((t) => t.path.endsWith('b.ts')) || { model: { getValue: () => '' } }).model.getValue());
    if (bText.includes('hello(')) break;
    await page.waitForTimeout(500);
  }
  expect(bText).toContain('import { hello }');

  // status dialog lists servers
  await page.evaluate(() => window.__lsp.showServerStatus());
  await expect(page.locator('#lsp-status-dialog')).toContainText('typescript');
  await expect(page.locator('#lsp-status-dialog')).toContainText('gopls');
  // the rename left unsaved edits; quitting would otherwise wait on the unsaved-changes prompt
  await page.evaluate(() => state.openTabs.forEach((t) => { t.modified = false; }));
  await app.close();
});
