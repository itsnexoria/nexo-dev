
// ---------------- Context menu ----------------
function copyPathsToClipboard(paths: any, relative: any) {
  const text = paths.map((p: any) => {
    if (!relative || !state.projectRoot) return p;
    return p.startsWith(state.projectRoot) ? p.slice(state.projectRoot.length + 1) : p;
  }).join('\n');
  navigator.clipboard.writeText(text).catch(() => {});
}

async function addToGitignore(targetPath: any, isDir: any) {
  if (!state.projectRoot) return;
  let rel = targetPath.startsWith(state.projectRoot) ? targetPath.slice(state.projectRoot.length + 1) : targetPath;
  rel = rel.replace(/\\/g, '/');
  if (isDir) rel += '/';
  const sep = state.projectRoot.includes('\\') ? '\\' : '/';
  const gitignorePath = state.projectRoot + sep + '.gitignore';
  const res = await window.nexo.readFile(gitignorePath);
  let content = res.ok ? res.content : '';
  const lines = content.split(/\r?\n/);
  if (lines.some((l: any) => l.trim() === rel)) { flashToast(`${rel} is already in .gitignore`); return; }
  if (content.length && !content.endsWith('\n')) content += '\n';
  content += rel + '\n';
  const writeRes = await window.nexo.writeFile(gitignorePath, content);
  if (!writeRes.ok) { flashToast(`Could not update .gitignore: ${writeRes.error || 'unknown error'}`); return; }
  flashToast(`Added ${rel} to .gitignore`);
  const tab = state.openTabs.find((t) => t.path === gitignorePath);
  if (tab) tab.model.setValue(content);
  // The explorer tree filters against gitState.ignoredPaths, which otherwise
  // only gets refreshed as a side effect of refreshGitStatus() — so without
  // this, adding an entry while the Git panel isn't open would leave the
  // just-ignored item visible in the tree until something else happened to
  // trigger a status refresh.
  if (document.getElementById('panel-git')!.classList.contains('active')) refreshGitStatus();
  else await refreshIgnoredPaths();
  renderTree();
}

async function confirmBulkDelete(paths: any) {
  const ok = confirm(`Delete ${paths.length} selected items?`);
  if (!ok) return;
  let anyPermanent = false;
  for (const p of paths) {
    const res = await window.nexo.deleteItem(p);
    if (res.ok && res.trashed === false) anyPermanent = true;
    const toClose = state.openTabs.filter((t) => t.path === p || t.path.startsWith(p + '/') || t.path.startsWith(p + '\\'));
    for (const t of toClose) { t.modified = false; closeTab(t.path); }
  }
  if (anyPermanent) flashToast("Some items couldn't be moved to the system trash and were permanently deleted.");
  state.selectedPaths.clear();
  await renderTree();
}

function showContextMenu(x: any, y: any, isDirectory: any) {
  const menu = document.getElementById('context-menu');
  const items = [];
  const multiCount = state.selectedPaths.size;

  if (multiCount >= 2) {
    const paths = [...state.selectedPaths];
    items.push({ label: `Delete ${multiCount} Items`, danger: true, action: () => confirmBulkDelete(paths) });
    items.push({ sep: true });
    items.push({ label: 'Copy Paths', action: () => copyPathsToClipboard(paths, false) });
    items.push({ label: 'Copy Relative Paths', action: () => copyPathsToClipboard(paths, true) });
  } else {
    if (isDirectory) {
      items.push({ label: 'New File', action: () => promptNewFile(state.contextTarget.path) });
      items.push({ label: 'New Folder', action: () => promptNewFolder(state.contextTarget.path) });
      items.push({ sep: true });
    }
    items.push({ label: 'Copy Path', action: () => copyPathsToClipboard([state.contextTarget.path], false) });
    items.push({ label: 'Copy Relative Path', action: () => copyPathsToClipboard([state.contextTarget.path], true) });
    items.push({ sep: true });
    if (state.contextTarget.path !== state.projectRoot) {
      items.push({ label: 'Rename', action: () => promptRename(state.contextTarget.path) });
      items.push({ label: 'Reveal in Explorer', action: () => window.nexo.revealInFolder(state.contextTarget.path) });
      items.push({ label: 'Add to .gitignore', action: () => addToGitignore(state.contextTarget.path, isDirectory) });
      items.push({ sep: true });
      items.push({ label: 'Delete', danger: true, action: () => confirmDelete(state.contextTarget.path, isDirectory) });
    } else {
      items.push({ label: 'Reveal in Explorer', action: () => window.nexo.revealInFolder(state.contextTarget.path) });
    }
  }

  menu!.innerHTML = '';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu!.appendChild(s); continue; }
    const d = document.createElement('div');
    d.className = 'ctx-item' + (it.danger ? ' danger' : '');
    d.textContent = it.label!;
    d.addEventListener('click', () => { hideContextMenu(); it.action!(); });
    menu!.appendChild(d);
  }
  menu!.style.left = x + 'px';
  menu!.style.top = y + 'px';
  menu!.classList.remove('hidden');
}
function hideContextMenu() { document.getElementById('context-menu')!.classList.add('hidden'); }
document.addEventListener('click', hideContextMenu);

// ---------------- Modal (dynamic multi-field forms) ----------------
// fields: [{ id, label, placeholder, initial, required }]
// onConfirm(values) -> return an error string to keep the modal open, or null/undefined to close it.
function showModal({ title, fields, confirmLabel = 'Create', onConfirm }: any) {
  const overlay = document.getElementById('modal-overlay');
  const fieldsBox = document.getElementById('modal-fields');
  const errBox = document.getElementById('modal-error');
  document.getElementById('modal-title')!.textContent = title;
  document.getElementById('modal-confirm')!.textContent = confirmLabel;
  errBox!.textContent = '';

  fieldsBox!.innerHTML = '';
  const inputs: Record<string, any> = {};
  fields.forEach((f: any, i: any) => {
    if (f.label) {
      const lbl = document.createElement('div');
      lbl.className = 'modal-field-label';
      lbl.textContent = f.label;
      fieldsBox!.appendChild(lbl);
    }
    const inp = document.createElement('input');
    inp.id = `modal-field-${f.id}`;
    inp.type = f.type || 'text';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.placeholder = f.placeholder || '';
    inp.value = f.initial || '';
    inp.style.marginBottom = i < fields.length - 1 ? '10px' : '0';
    fieldsBox!.appendChild(inp);
    inputs[f.id] = inp;
  });

  overlay!.classList.remove('hidden');
  const firstInput = inputs[fields[0].id];
  firstInput.focus();
  firstInput.select();

  const confirmBtn = document.getElementById('modal-confirm');
  const cancelBtn = document.getElementById('modal-cancel');

  function close() {
    overlay!.classList.add('hidden');
    confirmBtn!.removeEventListener('click', onOk);
    cancelBtn!.removeEventListener('click', onCancel);
    Object.values(inputs).forEach((inp) => inp.removeEventListener('keydown', onKey));
  }
  async function onOk() {
    const values: Record<string, any> = {};
    for (const f of fields) {
      const val = inputs[f.id].value.trim();
      if (f.required !== false && !val) { errBox!.textContent = `${f.label || 'This field'} cannot be empty.`; return; }
      values[f.id] = val;
    }
    const err = await onConfirm(values);
    if (err) { errBox!.textContent = err; return; }
    close();
  }
  function onCancel() { close(); }
  function onKey(e: any) {
    if (e.key === 'Enter') onOk();
    if (e.key === 'Escape') onCancel();
  }
  confirmBtn!.addEventListener('click', onOk);
  cancelBtn!.addEventListener('click', onCancel);
  Object.values(inputs).forEach((inp) => inp.addEventListener('keydown', onKey));
}

function promptNewFile(dirPath: any) {
  showModal({
    title: 'New File',
    fields: [{ id: 'name', placeholder: 'filename.ext' }],
    onConfirm: async ({ name }: any) => {
      const res = await window.nexo.createFile(dirPath, name);
      if (!res.ok) return res.error;
      state.expanded.add(dirPath);
      await renderTree();
      openFile(res.path);
      return null;
    },
  });
}

function promptNewFolder(dirPath: any) {
  showModal({
    title: 'New Folder',
    fields: [{ id: 'name', placeholder: 'folder-name' }],
    onConfirm: async ({ name }: any) => {
      const res = await window.nexo.createFolder(dirPath, name);
      if (!res.ok) return res.error;
      state.expanded.add(dirPath);
      await renderTree();
      return null;
    },
  });
}

function promptRename(targetPath: any) {
  const currentName = targetPath.split(/[\\/]/).pop();
  showModal({
    title: 'Rename',
    confirmLabel: 'Rename',
    fields: [{ id: 'name', initial: currentName }],
    onConfirm: async ({ name }: any) => {
      if (name === currentName) return null;
      const res = await window.nexo.rename(targetPath, name);
      if (!res.ok) return res.error;
      const tab = state.openTabs.find((t) => t.path === targetPath);
      if (tab) {
        tab.path = res.path;
        tab.name = name;
        if (state.activeTab === targetPath) state.activeTab = res.path;
        if (splitState.tabPath === targetPath) splitState.tabPath = res.path;
      }
      await renderTree();
      renderTabs();
      if (splitState.visible) updateSplitTabOptions();
      return null;
    },
  });
}

async function confirmDelete(targetPath: any, isDirectory: any) {
  const name = targetPath.split(/[\\/]/).pop();
  const ok = confirm(`Delete "${name}"?`);
  if (!ok) return;
  const res = await window.nexo.deleteItem(targetPath);
  if (!res.ok) { alert(`Could not delete:\n${res.error}`); return; }
  if (res.trashed === false) flashToast(`"${name}" was permanently deleted (couldn't move it to the system trash).`);
  // close any open tabs under this path
  const toClose = state.openTabs.filter((t) => t.path === targetPath || t.path.startsWith(targetPath + '/') || t.path.startsWith(targetPath + '\\'));
  for (const t of toClose) {
    t.modified = false; // skip unsaved prompt, it's gone
    closeTab(t.path);
  }
  await renderTree();
}

// ---------------- Sidebar resize ----------------
(function setupResizer() {
  const resizer = document.getElementById('resizer');
  const sidebar = document.getElementById('sidebar');
  let dragging = false;
  resizer!.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'col-resize'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.max(160, Math.min(500, e.clientX));
    sidebar!.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; });
})();
