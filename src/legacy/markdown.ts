

// ---------------- Markdown preview ----------------
function renderMarkdownPreview(tab: any) {
  const box = document.getElementById('markdown-preview-content');
  try {
    if (window.marked) {
      const raw = marked.parse(tab.model.getValue());
      box!.innerHTML = window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
    } else {
      // Most likely cause: node_modules/marked isn't installed — either the
      // project was set up before "marked" was added to package.json, or
      // node_modules got copied/moved without it. Either way, "npm install"
      // fixes it.
      box!.innerHTML = `
        <p><strong>Markdown renderer not available.</strong></p>
        <p>The <code>marked</code> package (used to render previews) doesn't seem to be installed. Run this in the project folder and restart the app:</p>
        <pre><code>npm install</code></pre>
        <p style="color:var(--text-muted)">You can still view/edit the raw source with the "✏️ Edit" button above.</p>
      `;
    }
  } catch (err) {
    box!.innerHTML = `<p>Could not render markdown: ${escapeHtml(err.message)}</p>`;
  }
  document.getElementById('markdown-preview')!.style.display = 'flex';
}

function setMarkdownMode(tab: any, mode: any) {
  tab.mdMode = mode;
  if (state.activeTab !== tab.path) return;
  if (mode === 'preview') {
    document.getElementById('editor-container')!.style.display = 'none';
    document.getElementById('editor-container')!.classList.remove('push-down');
    document.getElementById('md-preview-btn')!.classList.add('hidden');
    document.getElementById('conflict-banner')!.classList.remove('active');
    renderMarkdownPreview(tab);
  } else {
    document.getElementById('markdown-preview')!.style.display = 'none';
    document.getElementById('editor-container')!.style.display = 'block';
    document.getElementById('md-preview-btn')!.classList.remove('hidden');
    editor.focus();
    updateConflictBanner();
  }
}

document.getElementById('md-preview-btn')!.addEventListener('click', () => {
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (tab) setMarkdownMode(tab, 'preview');
});
document.getElementById('md-edit-btn')!.addEventListener('click', () => {
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (tab) setMarkdownMode(tab, 'edit');
});
// External links in a rendered preview should open in the system browser —
// there's no in-app page navigation for them to go to.
document.getElementById('markdown-preview-content')!.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href') || '';
  if (/^https?:\/\//i.test(href)) window.nexo.openExternal(href);
});

const autoSaveTimers = new Map();
function maybeAutoSave(filePath: any) {
  if (!uiState.autoSave) return;
  clearTimeout(autoSaveTimers.get(filePath));
  const timer = setTimeout(async () => {
    autoSaveTimers.delete(filePath);
    const tab = state.openTabs.find((t) => t.path === filePath);
    if (!tab || !tab.modified) return;
    if (scanConflicts(tab.model).length) return; // don't silently persist unresolved conflict markers
    const res = await window.nexo.writeFile(tab.path, tab.model.getValue());
    if (res.ok) {
      tab.modified = false;
      renderTabs();
    }
  }, uiState.autoSaveDelayMs);
  autoSaveTimers.set(filePath, timer);
}

async function formatTabWithPrettier(tab: any) {
  if (!state.projectRoot) return false;
  const isPy = /\.pyw?$/i.test(tab.path);
  const res = isPy
    ? await window.nexo.pyFormat(state.projectRoot, tab.path, tab.model.getValue())
    : await window.nexo.formatWithPrettier(state.projectRoot, tab.path, tab.model.getValue());
  if (!res.ok) return false; // no local prettier, or it couldn't parse this file — leave content untouched
  if (res.formatted === tab.model.getValue()) return false; // already formatted, avoid a no-op undo entry
  const fullRange = tab.model.getFullModelRange();
  tab.model.pushEditOperations([], [{ range: fullRange, text: res.formatted }], () => null as any);
  return true;
}

async function formatActiveDocument() {
  if (!state.activeTab) return;
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (!tab || tab.isImage) return;
  const formatted = await formatTabWithPrettier(tab);
  if (!formatted) flashToast('Nothing to format — no local Prettier install found (ruff/black for Python), or this file type isn\'t supported.');
}

async function saveActiveTab() {
  if (!state.activeTab) return;
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (!tab || tab.isImage) return;
  if (scanConflicts(tab.model).length) {
    const proceed = confirm('This file still has unresolved merge conflict markers (<<<<<<< / ======= / >>>>>>>).\n\nSave anyway?');
    if (!proceed) return;
  }
  if (uiState.formatOnSave) await formatTabWithPrettier(tab);
  applyEditorConfigNormalization(tab);
  const res = await window.nexo.writeFile(tab.path, tab.model.getValue());
  if (!res.ok) { alert(`Could not save file:\n${res.error}`); return; }
  tab.modified = false;
  renderTabs();
  lintFile(tab.path);
  refreshBlameForTab(tab.path);
}

async function saveActiveTabAs() {
  if (!state.activeTab) return;
  const tab = state.openTabs.find((t) => t.path === state.activeTab);
  if (!tab || tab.isImage) return;
  if (scanConflicts(tab.model).length) {
    const proceed = confirm('This file still has unresolved merge conflict markers (<<<<<<< / ======= / >>>>>>>).\n\nSave anyway?');
    if (!proceed) return;
  }
  const newPath = await window.nexo.saveAsDialog(tab.name);
  if (!newPath) return;
  applyEditorConfigNormalization(tab);
  const res = await window.nexo.writeFile(newPath, tab.model.getValue());
  if (!res.ok) { alert(`Could not save file:\n${res.error}`); return; }
  await openFile(newPath);
  renderTree();
}
