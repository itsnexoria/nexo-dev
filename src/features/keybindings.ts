


// user overrides live in prefs.keybindings and are applied by a capture-phase handler that runs first.
(function () {
  const K = window.NexoKeys;
  const REGISTRY = [
    { id: 'file.open', label: 'Open Folder', chord: 'Ctrl+O', run: () => handleOpenFolder() },
    { id: 'file.new', label: 'New File', chord: 'Ctrl+N', run: () => handleNewFile() },
    { id: 'file.save', label: 'Save', chord: 'Ctrl+S', run: () => saveActiveTab() },
    { id: 'file.saveAs', label: 'Save As', chord: 'Ctrl+Shift+S', run: () => saveActiveTabAs() },
    { id: 'tab.close', label: 'Close Tab', chord: 'Ctrl+W', run: () => state.activeTab && closeTab(state.activeTab) },
    { id: 'tab.reopen', label: 'Reopen Closed Tab', chord: 'Ctrl+Shift+T', run: () => reopenClosedTab() },
    { id: 'view.search', label: 'Find in Files', chord: 'Ctrl+Shift+F', run: () => switchRailView('search') },
    { id: 'view.git', label: 'Source Control', chord: 'Ctrl+Shift+G', run: () => switchRailView('git') },
    { id: 'view.sidebar', label: 'Toggle Sidebar', chord: 'Ctrl+B', run: () => { const sb = document.getElementById('sidebar')!; sb.style.display = sb.style.display === 'none' ? 'flex' : 'none'; } },
    { id: 'view.terminal', label: 'Toggle Terminal', chord: 'Ctrl+`', run: () => toggleTerminal() },
    { id: 'view.split', label: 'Toggle Split Editor', chord: 'Ctrl+\\', run: () => toggleSplit() },
    { id: 'palette.files', label: 'Quick Open (files)', chord: 'Ctrl+P', run: () => openPalette('files') },
    { id: 'palette.commands', label: 'Command Palette', chord: 'Ctrl+Shift+P', run: () => openPalette('commands') },
    { id: 'font.bigger', label: 'Zoom In', chord: 'Ctrl+=', run: () => changeFontSize(1) },
    { id: 'font.smaller', label: 'Zoom Out', chord: 'Ctrl+-', run: () => changeFontSize(-1) },
    { id: 'font.reset', label: 'Reset Zoom', chord: 'Ctrl+0', run: () => resetFontSize() },
    { id: 'editor.format', label: 'Format Document', chord: 'Alt+Shift+F', run: () => formatActiveDocument() },
    { id: 'debug.start', label: 'Debug: Start / Continue', chord: 'F5', run: () => { if (dbg.active) dbgControl('continue'); else startDebug(); } },
    { id: 'debug.stop', label: 'Debug: Stop', chord: 'Shift+F5', run: () => dbgApi().stop() },
    { id: 'debug.over', label: 'Debug: Step Over', chord: 'F10', run: () => dbgControl('next') },
    { id: 'debug.into', label: 'Debug: Step Into', chord: 'F11', run: () => dbgControl('stepIn') },
    { id: 'debug.out', label: 'Debug: Step Out', chord: 'Shift+F11', run: () => dbgControl('stepOut') },
    { id: 'python.run', label: 'Python: Run Current File', chord: 'Ctrl+F5', run: () => runPythonFile() },
  ];
  const byId = new Map(REGISTRY.map((c) => [c.id, c]));
  let overrides: Record<string, any> = {};

  // Every palette command can be bound too (id "cmd:<label>").
  const paletteCmds = () => PALETTE_COMMANDS.map((c) => ({ id: 'cmd:' + c.label, label: c.label, chord: null as string | null, run: c.run, palette: true }));
  const allCommands = () => [...REGISTRY, ...paletteCmds().filter((p) => !REGISTRY.some((r) => r.label === p.label))];
  const defaults = () => Object.fromEntries(allCommands().map((c) => [c.id, c.chord]));
  const effective = () => K.effective(defaults(), overrides);
  const chordOf = (id: any) => effective()[id] || null;
  const commandById = (id: any) => allCommands().find((c) => c.id === id);

  async function save() {
    const r = await window.nexo.setPrefs({ keybindings: overrides });
    if (r && r.keybindings) overrides = r.keybindings;
  }
  function setBinding(id: any, chord: any) {
    const def = (commandById(id) || {}).chord || null;
    const n = chord === null ? null : K.normalizeChord(chord);
    if (chord !== null && !n) return false;
    if (n === def) delete overrides[id]; else overrides[id] = n;
    uiState.keybindings = overrides;
    save();
    return true;
  }

  // ---------- dispatch (capture phase: runs before the legacy handlers and Monaco) ----------
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('kb-dialog') && document.getElementById('kb-dialog')!.dataset.recording) return; // recorder owns the keyboard
    const chord = K.chordFromEvent(e);
    if (!chord || !K.isGlobalChord(chord)) return;
    const eff = effective();
    const hit = Object.keys(eff).find((id) => eff[id] === chord && (id in overrides || !byId.has(id)));
    if (hit) {
      const cmd = commandById(hit);
      if (cmd) { e.preventDefault(); e.stopImmediatePropagation(); cmd.run(); return; }
    }
    // a built-in default the user moved away (or unbound): swallow it so the legacy handler doesn't fire
    for (const c of REGISTRY) {
      if (c.chord === chord && c.id in overrides && eff[c.id] !== chord && !Object.keys(eff).some((id) => eff[id] === chord)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    }
  }, true);

  // ---------- editor dialog ----------
  const el = (tag: string, props: Record<string, any> = {}, ...kids: any[]) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  };
  function openDialog() {
    if (document.getElementById('kb-dialog')) return;
    const overlay = el('div', { id: 'kb-dialog', class: 'lsp-status-dialog', role: 'dialog', 'aria-label': 'Keyboard Shortcuts' });
    const search: any = el('input', { id: 'kb-search', type: 'search', placeholder: 'Search commands or shortcuts…', spellcheck: 'false' });
    const list = el('div', { class: 'lsp-status-scroll', id: 'kb-list' });
    const note = el('div', { class: 'db-note', id: 'kb-note' });
    function close() { overlay.remove(); document.removeEventListener('keydown', onEsc, true); }
    function onEsc(e: any) { if (e.key === 'Escape' && !overlay.dataset.recording) { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onEsc, true);

    function record(id: any, cell: any) {
      overlay.dataset.recording = '1';
      cell.replaceChildren(el('span', { class: 'kb-recording', text: 'Press keys… (Esc cancels, Backspace unbinds)' }));
      const onKey = (e: any) => {
        if (K.MODIFIER_KEYS.has(String(e.key).toLowerCase())) return;
        e.preventDefault(); e.stopPropagation();
        document.removeEventListener('keydown', onKey, true);
        setTimeout(() => { delete overlay.dataset.recording; }, 0);
        if (e.key === 'Escape') { render(); return; }
        if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey) { setBinding(id, null); save(); render(); return; }
        const chord = K.chordFromEvent(e);
        if (!K.isGlobalChord(chord)) { note.textContent = `"${chord}" needs a modifier (Ctrl/Alt/Meta) or an F-key.`; render(); return; }
        setBinding(id, chord); save(); note.textContent = ''; render();
      };
      document.addEventListener('keydown', onKey, true);
    }
    function render() {
      const q = search.value.trim().toLowerCase();
      const eff = effective();
      const conflicts: Map<string, string[]> = new Map(K.findConflicts(eff).map((c: any) => [c.chord, c.ids]));
      const rows = allCommands().filter((c) => !q || c.label.toLowerCase().includes(q) || (eff[c.id] || '').toLowerCase().includes(q))
        .sort((a, b) => Number(!!eff[b.id]) - Number(!!eff[a.id]) || a.label.localeCompare(b.label))
        .slice(0, 300).map((c) => {
          const chord = eff[c.id];
          const conflict = chord && conflicts.get(chord);
          const cell = el('td', { class: 'kb-chord' });
          cell.append(chord ? el('kbd', { text: chord }) : el('span', { class: 'kb-none', text: '—' }));
          if (conflict) cell.append(el('span', { class: 'kb-conflict', title: 'Also bound to: ' + conflict.filter((i: any) => i !== c.id).map((i: any) => (commandById(i) || {}).label || i).join(', '), text: ' ⚠ conflict' }));
          return el('tr', { 'data-id': c.id },
            el('td', { text: c.label }), cell,
            el('td', { class: 'kb-actions' },
              el('button', { class: 'git-section-action kb-edit', text: 'Change', onclick: () => record(c.id, cell) }),
              c.id in overrides ? el('button', { class: 'git-section-action', text: 'Reset', onclick: () => { delete overrides[c.id]; uiState.keybindings = overrides; save(); render(); } }) : null));
        });
      list.replaceChildren(el('table', { class: 'db-grid kb-table' }, el('thead', {}, el('tr', {}, el('th', { text: 'Command' }), el('th', { text: 'Shortcut' }), el('th', { text: '' }))), el('tbody', {}, ...rows)));
    }
    search.addEventListener('input', render);
    async function exportJson() {
      const file = await window.nexo.saveAsDialog('nexo-keybindings.json');
      if (!file) return;
      const r = await window.nexo.writeFile(file, JSON.stringify(overrides, null, 2) + '\n');
      flashToast(r.ok ? 'Keybindings exported.' : 'Export failed: ' + r.error);
    }
    async function importJson() {
      const file = await window.nexo.pickFile('Import keybindings', [{ name: 'JSON', extensions: ['json'] }]);
      if (!file) return;
      const r = await window.nexo.readFile(file);
      if (!r.ok) { flashToast(r.error); return; }
      let data; try { data = JSON.parse(r.content); } catch { flashToast('That file is not valid JSON.'); return; }
      const clean = K.sanitizeOverrides(data);
      overrides = clean; uiState.keybindings = overrides; await save(); render(); flashToast(`Imported ${Object.keys(clean).length} keybinding(s).`);
    }
    overlay.append(el('div', { class: 'lsp-status-card', style: 'width:min(820px,94vw)' },
      el('h3', { text: 'Keyboard Shortcuts' }), search, note, list,
      el('div', { class: 'lsp-status-actions', style: 'justify-content:space-between' },
        el('span', {}, el('button', { class: 'tbtn', id: 'kb-export', text: 'Export…', onclick: exportJson }), ' ', el('button', { class: 'tbtn', id: 'kb-import', text: 'Import…', onclick: importJson }), ' ',
          el('button', { class: 'tbtn', id: 'kb-reset-all', text: 'Reset all', onclick: () => { if (confirm('Reset all shortcuts to their defaults?')) { overrides = {}; uiState.keybindings = overrides; save(); render(); } } })),
        el('button', { class: 'tbtn', id: 'kb-close', text: 'Close', onclick: close }))));
    overlay.addEventListener('mousedown', (e: any) => { if (e.target === overlay) close(); });
    document.body.append(overlay);
    render(); search.focus();
  }
  window.nexoKeybindings = { openDialog, effective, setBinding, get overrides() { return overrides; } };
  PALETTE_COMMANDS.push({ label: 'Preferences: Keyboard Shortcuts', run: openDialog } as any);

  // Menu entry + persisted overrides
  try { if (typeof APP_MENUS !== 'undefined' && APP_MENUS.view) (APP_MENUS.view as any[]).push({ separator: true }, { label: 'Keyboard Shortcuts…', run: openDialog }); } catch { /* menu shape differs */ }
  window.nexo.getPrefs().then((p) => { overrides = K.sanitizeOverrides(p && p.keybindings); uiState.keybindings = overrides; });
})();
