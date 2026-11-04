// Compare the active file with another open file or the clipboard (Monaco diff in an overlay).
(function () {
  let editor: any = null;
  let overlay: HTMLElement | null = null;

  function close() {
    if (editor) {
      const m = editor.getModel();
      try { editor.dispose(); } catch { /* gone */ }
      if (m) { try { m.original.dispose(); m.modified.dispose(); } catch { /* gone */ } }
      editor = null;
    }
    if (overlay) { overlay.remove(); overlay = null; }
  }

  function show(leftLabel: string, left: string, rightLabel: string, right: string, lang: string, extra?: HTMLElement) {
    close();
    overlay = document.createElement('div');
    overlay.id = 'compare-overlay';
    const box = document.createElement('div');
    box.id = 'compare-box';
    const bar = document.createElement('div');
    bar.className = 'compare-bar';
    const title = document.createElement('span');
    title.className = 'compare-title';
    title.textContent = `${leftLabel}  ↔  ${rightLabel}`;
    bar.append(title);
    if (extra) bar.append(extra);
    const x = document.createElement('button');
    x.id = 'compare-close';
    x.textContent = '✕';
    x.addEventListener('click', close);
    bar.append(x);
    const host = document.createElement('div');
    host.id = 'compare-host';
    box.append(bar, host);
    overlay.append(box);
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.body.append(overlay);
    editor = monaco.editor.createDiffEditor(host, {
      readOnly: true, renderSideBySide: true, automaticLayout: true, originalEditable: false,
      fontSize: uiState.fontSize, minimap: { enabled: false }, scrollBeyondLastLine: false,
    });
    editor.setModel({ original: monaco.editor.createModel(left, lang), modified: monaco.editor.createModel(right, lang) });
    overlay.tabIndex = -1;
    overlay.focus();
  }

  function active(): any {
    const t = state.openTabs.find((x: any) => x.path === state.activeTab);
    return t && t.model ? t : null;
  }

  async function withClipboard() {
    const t = active();
    if (!t) { flashToast('Open a text file first'); return; }
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { flashToast('Could not read the clipboard'); return; }
    show(t.name, t.model.getValue(), 'Clipboard', text, t.model.getLanguageId());
  }

  function withTab() {
    const t = active();
    if (!t) { flashToast('Open a text file first'); return; }
    const others = state.openTabs.filter((x: any) => x !== t && x.model);
    if (!others.length) { flashToast('Open a second text file to compare with'); return; }
    const sel = document.createElement('select');
    sel.id = 'compare-select';
    others.forEach((o: any, i: number) => { const op = document.createElement('option'); op.value = String(i); op.textContent = o.name; sel.append(op); });
    const render = () => { const o = others[Number(sel.value)]; show(t.name, t.model.getValue(), o.name, o.model.getValue(), t.model.getLanguageId(), sel); };
    sel.addEventListener('change', render);
    render();
  }

  PALETTE_COMMANDS.push(
    { label: 'Compare Active File With…', run: withTab },
    { label: 'Compare Active File With Clipboard', run: withClipboard },
  );
  (window as any).nexoCompare = { withTab, withClipboard, close };
})();
