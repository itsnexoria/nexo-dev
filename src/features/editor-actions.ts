// Extra editor commands in the palette: line/case transforms, view toggles, path helpers.
(function () {
  const ed = () => editor as any;
  const hasText = () => { if (!ed() || !ed().getModel()) { flashToast('Open a text file first'); return false; } return true; };
  const act = (id: string) => () => { if (!hasText()) return; const a = ed().getAction(id); if (a) a.run(); else flashToast('Not available in this editor'); };

  // Applies fn to the selected lines (or the whole file when nothing is selected).
  function mapLines(fn: (lines: string[]) => string[]) {
    if (!hasText()) return;
    const model = ed().getModel();
    let sel = ed().getSelection();
    const whole = !sel || sel.isEmpty();
    const startLine = whole ? 1 : sel.startLineNumber;
    const endLine = whole ? model.getLineCount() : (sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber);
    const range = new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
    const out = fn(model.getValueInRange(range).split(model.getEOL()));
    ed().executeEdits('nexo.lines', [{ range, text: out.join(model.getEOL()) }]);
    ed().pushUndoStop();
  }

  const toggle = (key: 'minimap' | 'wordWrap', apply: () => void) => () => { (uiState as any)[key] = !(uiState as any)[key]; apply(); window.nexo.setPrefs({ [key]: (uiState as any)[key] }); flashToast(`${key === 'wordWrap' ? 'Word wrap' : 'Minimap'} ${(uiState as any)[key] ? 'on' : 'off'}`); };

  const relPath = (p: string) => (state.projectRoot && p.startsWith(state.projectRoot) ? p.slice(state.projectRoot.length + 1) : p);
  const copy = async (text: string, what: string) => { try { await navigator.clipboard.writeText(text); flashToast(`${what} copied`); } catch { flashToast('Could not write the clipboard'); } };

  const cmds: Array<{ label: string; run: () => void }> = [
    { label: 'Transform: Uppercase', run: act('editor.action.transformToUppercase') },
    { label: 'Transform: Lowercase', run: act('editor.action.transformToLowercase') },
    { label: 'Transform: Title Case', run: act('editor.action.transformToTitlecase') },
    { label: 'Transform: snake_case', run: act('editor.action.transformToSnakecase') },
    { label: 'Lines: Sort Ascending', run: act('editor.action.sortLinesAscending') },
    { label: 'Lines: Sort Descending', run: act('editor.action.sortLinesDescending') },
    { label: 'Lines: Join', run: act('editor.action.joinLines') },
    { label: 'Lines: Remove Duplicates', run: () => mapLines((l) => [...new Set(l)]) },
    { label: 'Lines: Reverse', run: () => mapLines((l) => l.reverse()) },
    { label: 'Lines: Remove Empty', run: () => mapLines((l) => l.filter((x) => x.trim() !== '')) },
    { label: 'Whitespace: Trim Trailing', run: act('editor.action.trimTrailingWhitespace') },
    { label: 'Indentation: Convert to Spaces', run: act('editor.action.indentationToSpaces') },
    { label: 'Indentation: Convert to Tabs', run: act('editor.action.indentationToTabs') },
    { label: 'Fold All', run: act('editor.foldAll') },
    ...[1, 2, 3, 4, 5].map((n) => ({ label: `Fold: Level ${n}`, run: act(`editor.foldLevel${n}`) })),
    { label: 'Fold: All Block Comments', run: act('editor.foldAllBlockComments') },
    { label: 'Fold: All Regions (#region)', run: act('editor.foldAllMarkerRegions') },
    { label: 'Fold: Unfold All Regions', run: act('editor.unfoldAllMarkerRegions') },
    { label: 'Fold: Toggle at Cursor', run: act('editor.toggleFold') },
    { label: 'Unfold All', run: act('editor.unfoldAll') },
    { label: 'View: Toggle Word Wrap', run: toggle('wordWrap', () => applyEditorOptionToBoth({ wordWrap: uiState.wordWrap ? 'on' : 'off' })) },
    { label: 'View: Toggle Minimap', run: toggle('minimap', () => applyEditorOptionToBoth({ minimap: { enabled: uiState.minimap, renderCharacters: false, maxColumn: 80 } })) },
    { label: 'View: Toggle Render Whitespace', run: () => { if (!hasText()) return; const on = ed().getOption(monaco.editor.EditorOption.renderWhitespace) !== 'none'; applyEditorOptionToBoth({ renderWhitespace: on ? 'none' : 'all' }); } },
    { label: 'View: Toggle Line Numbers', run: () => { if (!hasText()) return; const on = ed().getOption(monaco.editor.EditorOption.lineNumbers).renderType !== 0; applyEditorOptionToBoth({ lineNumbers: on ? 'off' : 'on' }); } },
    { label: 'Insert: Current Date and Time (ISO)', run: () => { if (!hasText()) return; ed().executeEdits('nexo.insert', [{ range: ed().getSelection(), text: new Date().toISOString() }]); } },
    { label: 'File: Copy Path', run: () => state.activeTab ? copy(state.activeTab, 'Path') : flashToast('No file open') },
    { label: 'File: Copy Relative Path', run: () => state.activeTab ? copy(relPath(state.activeTab), 'Relative path') : flashToast('No file open') },
    { label: 'File: Reveal in File Manager', run: () => state.activeTab ? window.nexo.revealInFolder(state.activeTab) : flashToast('No file open') },
  ];
  PALETTE_COMMANDS.push(...cmds);
  (window as any).nexoEditorActions = { mapLines };
})();
