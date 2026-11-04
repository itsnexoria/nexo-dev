nexo.statusBar.set('👋 hello-nexo', 'Hello Nexo extension is active');
nexo.commands.register('hello', async () => {
  const roots = await nexo.workspace.roots();
  await nexo.window.notify('Hello! Workspace roots: ' + roots.length);
});
nexo.commands.register('stamp', () => nexo.editor.insertText(new Date().toISOString()));
