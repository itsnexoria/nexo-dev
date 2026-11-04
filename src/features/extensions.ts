


// page CSP (connect-src 'self') blocks their network access. They talk to us only through the RPC below.
(function () {
  const BOOT = `
const __h = {}; let __id = 0; const __p = {};
const __post = self.postMessage.bind(self); const __close = self.close.bind(self);
const call = (m, a) => new Promise((res, rej) => { const i = ++__id; __p[i] = { res, rej }; __post({ t: 'call', i, m, a }); });
self.nexo = Object.freeze({
  commands: { register: (id, fn) => { __h[id] = fn; } },
  statusBar: { set: (text, tooltip) => call('status.set', { text: String(text), tooltip: tooltip ? String(tooltip) : '' }) },
  window: { notify: (text) => call('notify', { text: String(text) }) },
  workspace: { readFile: (p) => call('fs.read', { p }), writeFile: (p, c) => call('fs.write', { p, c }), roots: () => call('roots', {}) },
  editor: { getText: () => call('ed.get', {}), insertText: (t) => call('ed.insert', { t: String(t) }) },
});
self.onmessage = async (e) => {
  const d = e.data;
  if (d.t === 'ret') { const p = __p[d.i]; delete __p[d.i]; if (p) d.err ? p.rej(new Error(d.err)) : p.res(d.v); }
  else if (d.t === 'run') { try { if (!__h[d.id]) throw new Error('command not registered'); await __h[d.id](); } catch (err) { __post({ t: 'error', msg: String(err && err.message || err) }); } }
};
for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'Worker', 'SharedWorker', 'close', 'postMessage']) { try { Object.defineProperty(self, k, { value: undefined, configurable: false }); } catch {} }
`;
  const st: any = { exts: [], workers: new Map(), statusEls: new Map(), cmdEntries: new Map(), providers: [] };

  function remove(id: any) {
    const w = st.workers.get(id); if (w) { w.terminate(); st.workers.delete(id); }
    const s = st.statusEls.get(id); if (s) { s.remove(); st.statusEls.delete(id); }
    for (let i = PALETTE_COMMANDS.length - 1; i >= 0; i--) if (PALETTE_COMMANDS[i].__ext === id) PALETTE_COMMANDS.splice(i, 1);
    st.providers = st.providers.filter((p: any) => { if (p.id === id) { p.d.dispose(); return false; } return true; });
  }
  const inRoots = (p: any) => typeof p === 'string' && (state.roots && state.roots.length ? state.roots : [state.projectRoot]).filter(Boolean).some((r) => p === r || p.startsWith(r!.replace(/[\\/]+$/, '') + '/') || p.startsWith(r!.replace(/[\\/]+$/, '') + '\\'));

  function start(ext: any) {
    remove(ext.id);
    if (!ext.enabled || !ext.manifest) return;
    const m = ext.manifest;
    for (const c of m.commands) PALETTE_COMMANDS.push({ label: `${m.name}: ${c.title}`, __ext: ext.id, run: () => { const w = st.workers.get(ext.id); if (w) w.postMessage({ t: 'run', id: c.id }); else flashToast(`${m.name} has no code to run.`); } });
    for (const t of m.themes) {
      monaco.editor.defineTheme('ext-' + m.id + '-' + t.id, { base: t.base, inherit: true, rules: t.rules, colors: t.colors });
      PALETTE_COMMANDS.push({ label: `Theme: ${t.name} (${m.name})`, __ext: ext.id, run: () => monaco.editor.setTheme('ext-' + m.id + '-' + t.id) });
    }
    const byLang: Record<string, any[]> = {}; for (const s of m.snippets) (byLang[s.language] = byLang[s.language] || []).push(s);
    for (const [lang, snips] of Object.entries(byLang) as [string, any[]][]) {
      const d = monaco.languages.registerCompletionItemProvider(lang, { provideCompletionItems: (model: any, pos: any) => {
        const w = model.getWordUntilPosition(pos); const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
        return { suggestions: snips.map((s: any) => ({ label: s.prefix, kind: monaco.languages.CompletionItemKind.Snippet, insertText: s.body, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, documentation: s.description, detail: m.name, range })) };
      } });
      st.providers.push({ id: ext.id, d });
    }
    if (!ext.code) return;
    const url = URL.createObjectURL(new Blob([BOOT + '\n;(function(){\n' + ext.code + '\n})();'], { type: 'text/javascript' }));
    const w = new Worker(url); st.workers.set(ext.id, w);
    w.onerror = (e) => { e.preventDefault(); flashToast(`Extension ${m.name} crashed: ${e.message}`); };
    w.onmessage = async (e) => {
      const d = e.data;
      if (d.t === 'error') { flashToast(`${m.name}: ${d.msg}`); return; }
      if (d.t !== 'call') return;
      const reply = (v?: any, err?: any) => w.postMessage({ t: 'ret', i: d.i, v, err });
      try {
        const a = d.a || {};
        switch (d.m) {
          case 'notify': flashToast(`${m.name}: ${String(a.text).slice(0, 300)}`); reply(true); break;
          case 'status.set': {
            let el = st.statusEls.get(ext.id);
            if (!el) { el = document.createElement('span'); el.className = 'ext-status'; el.dataset.ext = ext.id; document.getElementById('status-right')!.prepend(el); st.statusEls.set(ext.id, el); }
            el.textContent = String(a.text).slice(0, 80); el.title = a.tooltip || m.name; reply(true); break;
          }
          case 'roots': reply((state.roots && state.roots.length ? state.roots : [state.projectRoot]).filter(Boolean)); break;
          case 'fs.read': { if (!inRoots(a.p)) throw new Error('path is outside the workspace'); const r = await window.nexo.readFile(a.p); if (!r.ok) throw new Error(r.error); reply(r.content); break; }
          case 'fs.write': { if (!inRoots(a.p)) throw new Error('path is outside the workspace'); const r = await window.nexo.writeFile(a.p, String(a.c)); if (!r.ok) throw new Error(r.error); reply(true); break; }
          case 'ed.get': reply(editor ? editor.getValue() : ''); break;
          case 'ed.insert': { if (!editor) throw new Error('no editor'); const sel = editor.getSelection(); editor.executeEdits('ext:' + ext.id, [{ range: sel, text: String(a.t), forceMoveMarkers: true }]); reply(true); break; }
          default: throw new Error('unknown method ' + d.m);
        }
      } catch (err: any) { reply(null, String(err.message || err)); }
    };
  }

  async function reload() {
    st.exts = await window.nexo.extList();
    for (const e of st.exts) start(e);
    return st.exts;
  }

  async function openPanel() {
    if (document.getElementById('ext-dialog')) return;
    const exts = await window.nexo.extList(); st.exts = exts;
    const overlay = document.createElement('div'); overlay.id = 'ext-dialog'; overlay.className = 'lsp-status-dialog'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', 'Extensions');
    const card = document.createElement('div'); card.className = 'lsp-status-card';
    const h = document.createElement('h3'); h.textContent = 'Extensions'; card.append(h);
    const list = document.createElement('div'); list.className = 'lsp-status-scroll'; list.id = 'ext-list';
    if (!exts.length) { const p = document.createElement('p'); p.className = 'db-note'; p.textContent = 'No extensions installed. Use "Open Extensions Folder" and drop an extension folder in (see docs/extensions.md).'; list.append(p); }
    for (const e of exts) {
      const row = document.createElement('div'); row.className = 'ext-row'; row.dataset.id = e.id;
      const info = document.createElement('div'); const b = document.createElement('b'); b.textContent = e.manifest ? `${e.manifest.name} ${e.manifest.version}` : e.id; info.append(b);
      const sub = document.createElement('div'); sub.className = 'db-note'; sub.textContent = e.error ? 'Error: ' + e.error : (e.manifest.description || ''); info.append(sub);
      row.append(info);
      if (e.manifest) {
        const btn = document.createElement('button'); btn.className = 'tbtn'; btn.textContent = e.enabled ? 'Disable' : 'Enable';
        btn.addEventListener('click', async () => { await window.nexo.extSetEnabled(e.id, !e.enabled); overlay.remove(); await reload(); openPanel(); });
        row.append(btn);
      }
      list.append(row);
    }
    const actions = document.createElement('div'); actions.className = 'lsp-status-actions';
    const open = document.createElement('button'); open.className = 'tbtn'; open.id = 'ext-open-folder'; open.textContent = 'Open Extensions Folder'; open.addEventListener('click', () => window.nexo.extOpenFolder());
    const rel = document.createElement('button'); rel.className = 'tbtn'; rel.textContent = 'Reload'; rel.addEventListener('click', async () => { overlay.remove(); await reload(); openPanel(); });
    const close = document.createElement('button'); close.className = 'tbtn'; close.id = 'ext-close'; close.textContent = 'Close'; close.addEventListener('click', () => overlay.remove());
    actions.append(open, rel, close); card.append(list, actions); overlay.append(card);
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) overlay.remove(); });
    document.body.append(overlay);
  }

  window.nexoExtensions = { reload, openPanel, state: st };
  PALETTE_COMMANDS.push({ label: 'Extensions: Manage', run: openPanel });
  PALETTE_COMMANDS.push({ label: 'Extensions: Open Extensions Folder', run: () => window.nexo.extOpenFolder() });
  (async () => {
    for (let i = 0; i < 600 && !(window.monaco && typeof editor !== 'undefined' && editor); i++) await sleep(100);
    if (window.monaco) reload();
  })();
})();
