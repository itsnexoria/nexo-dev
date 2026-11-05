// Emmet completions + line bookmarks.
(function () {
  // Monaco loads asynchronously after boot; resolve once the global flag flips.
  const whenMonaco = () => new Promise<void>((resolve) => { const t = setInterval(() => { if (monacoLoaded && editor) { clearInterval(t); resolve(); } }, 100); });
  // ---------- Emmet ----------
  function registerEmmet() {
    const E = window.NexoEmmet, S = window.NexoEmmetSuggest;
    if (!E || !S) return;
    monaco.languages.registerCompletionItemProvider(['html', 'css', 'scss', 'less'], {
      provideCompletionItems(model: any, pos: any) {
        const line = model.getLineContent(pos.lineNumber);
        const r = S.suggest(E, model.getLanguageId(), line, pos.column - 1);
        if (!r) return { suggestions: [] };
        return { suggestions: [{
          label: r.abbr, kind: monaco.languages.CompletionItemKind.Snippet, detail: 'Emmet abbreviation',
          documentation: { value: '```\n' + r.text.replace(/\$\{\d+(?::([^}]*))?\}/g, '$1') + '\n```' },
          insertText: r.text, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range: new monaco.Range(pos.lineNumber, r.start + 1, pos.lineNumber, r.end + 1), sortText: '0', preselect: true,
        }] };
      },
    });
  }
  whenMonaco().then(registerEmmet);

  // ---------- Bookmarks (in-memory, tracked by Monaco decorations so they follow edits) ----------
  const GLYPH = 'nexo-bookmark-glyph';
  const lines = (model: any): number[] => model.getAllDecorations().filter((d: any) => d.options.glyphMarginClassName === GLYPH).map((d: any) => d.range.startLineNumber).sort((a: number, b: number) => a - b);
  const idsAt = (model: any, line: number): string[] => model.getLineDecorations(line).filter((d: any) => d.options.glyphMarginClassName === GLYPH).map((d: any) => d.id);
  const ok = () => { if (!editor || !editor.getModel()) { flashToast('Open a text file first'); return false; } return true; };

  function toggle() {
    if (!ok()) return;
    const model = editor.getModel(), line = editor.getPosition().lineNumber, existing = idsAt(model, line);
    if (existing.length) { model.deltaDecorations(existing, []); flashToast('Bookmark removed'); return; }
    model.deltaDecorations([], [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, glyphMarginClassName: GLYPH, glyphMarginHoverMessage: { value: 'Bookmark' }, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }]);
    flashToast('Bookmark added');
  }
  function jump(dir: 1 | -1) {
    if (!ok()) return;
    const model = editor.getModel(), all = lines(model), cur = editor.getPosition().lineNumber;
    if (!all.length) { flashToast('No bookmarks in this file'); return; }
    const target = dir === 1 ? (all.find((l) => l > cur) ?? all[0]) : ([...all].reverse().find((l) => l < cur) ?? all[all.length - 1]);
    editor.setPosition({ lineNumber: target, column: 1 });
    editor.revealLineInCenter(target);
    editor.focus();
  }
  function clear() {
    if (!ok()) return;
    const model = editor.getModel(), ids = model.getAllDecorations().filter((d: any) => d.options.glyphMarginClassName === GLYPH).map((d: any) => d.id);
    model.deltaDecorations(ids, []);
    flashToast(ids.length ? `Cleared ${ids.length} bookmark(s)` : 'No bookmarks in this file');
  }

  PALETTE_COMMANDS.push(
    { label: 'Bookmarks: Toggle at Line', run: toggle, shortcut: 'Ctrl+Alt+B' },
    { label: 'Bookmarks: Next', run: () => jump(1) },
    { label: 'Bookmarks: Previous', run: () => jump(-1) },
    { label: 'Bookmarks: Clear in File', run: clear },
  );
  whenMonaco().then(() => {
    editor.addAction({ id: 'nexo.bookmark.toggle', label: 'Bookmarks: Toggle at Line', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyB], run: toggle });
  });
  window.nexoBookmarks = { toggle, next: () => jump(1), prev: () => jump(-1), clear, lines: () => (editor && editor.getModel() ? lines(editor.getModel()) : []) };
})();
