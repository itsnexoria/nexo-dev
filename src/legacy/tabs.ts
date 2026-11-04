

// ---------------- Tabs / Editor ----------------
async function openFile(filePath: any, opts: any = {}) {
  let tab = state.openTabs.find((t) => t.path === filePath);
  if (!tab) {
    const name = filePath.split(/[\\/]/).pop();
    const kind = getFileKind(name);
    if (kind === 'binary') {
      if (!opts.silent) alert(`"${name}" can't be opened — it looks like a binary file rather than text.`);
      return false;
    }
    if (kind === 'image') {
      tab = { path: filePath, name, model: null, modified: false, byteLength: 0, isImage: true, isMarkdown: false, mdMode: null, pinned: false };
      state.openTabs.push(tab);
      if (splitState.visible) updateSplitTabOptions();
    } else {
      if (!monacoLoaded) {
        document.getElementById('status-path')!.textContent = 'Loading editor…';
        await monacoReadyPromise;
      }
      const res = await window.nexo.readFile(filePath);
      if (!res.ok) {
        if (!opts.silent) alert(`Could not open file:\n${res.error}`);
        return false;
      }
      const lang = langFromName(name);
      const isMarkdown = /\.(md|markdown)$/i.test(name);
      const model = monaco.editor.createModel(res.content, lang);
      model.onDidChangeContent(() => {
        const t = state.openTabs.find((x) => x.path === filePath);
        if (t && !t.modified) { t.modified = true; renderTabs(); }
        if (editor && editor.getModel() === model) {
          updateConflictBanner();
          if (t && t.isMarkdown && t.mdMode === 'preview') renderMarkdownPreview(t);
          maybeAutoSave(filePath);
        }
        if (t && splitState.visible && splitState.tabPath === filePath && splitState.mdMode === 'preview') {
          renderSplitMarkdownPreview(t);
        }
        if (t && state.activeTab === filePath) scheduleOutlineRefresh();
        if (t) scheduleLint(filePath);
      });
      tab = { path: filePath, name, model, modified: false, byteLength: res.content.length, isMarkdown, mdMode: isMarkdown ? 'preview' : null, pinned: false };
      state.openTabs.push(tab);
      if (splitState.visible) updateSplitTabOptions();
      window.nexo.watchFile(filePath);
      applyEditorConfigToTab(tab);
    }
  }
  if (!opts.skipActivate) activateTab(filePath);
  if (!opts.silent) renderTree();
  if (!opts.silent) window.nexo.addRecentFile(filePath, state.projectRoot);
  return true;
}

function toFileUrl(p: any) {
  let pathName = p.replace(/\\/g, '/');
  if (!pathName.startsWith('/')) pathName = '/' + pathName;
  return 'file://' + encodeURI(pathName).replace(/#/g, '%23');
}

function showImagePreview(tab: any) {
  const box = document.getElementById('image-preview');
  const img = document.getElementById('image-preview-img') as HTMLImageElement;
  const meta = document.getElementById('image-preview-meta')!;
  meta.textContent = tab.name;
  img.onload = () => { meta.textContent = `${tab.name} — ${img.naturalWidth}×${img.naturalHeight}`; };
  img.onerror = () => { meta.textContent = `${tab.name} — couldn't load preview`; };
  img.src = toFileUrl(tab.path);
  box!.style.display = 'flex';
}

function updateEolIndicator(model: any) {
  const el = document.getElementById('status-eol');
  if (!model) { el!.classList.add('hidden'); return; }
  el!.classList.remove('hidden');
  el!.textContent = model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
}
document.getElementById('status-eol')!.addEventListener('click', () => {
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (!tab || tab.isImage || !tab.model) return;
  const current = tab.model.getEOL();
  const next = current === '\r\n' ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF;
  tab.model.pushEOL(next);
  updateEolIndicator(tab.model);
  if (!tab.modified) { tab.modified = true; renderTabs(); }
});
