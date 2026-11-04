


// Multi-root workspaces: several folders in one window, saved as a `.nexo-workspace` JSON file.
// The file tree, search, TODOs and quick-open span every root; Git / Scripts / Python / the
// terminal follow the *active* root (the one you last clicked or whose file you're editing).
'use strict';
(function (root) {
  const WS_EXT = '.nexo-workspace';
  const sepOf = (p: any) => (p.includes('\\') && !p.includes('/') ? '\\' : '/');
  const dirname = (p: any) => p.replace(/[\\/][^\\/]*$/, '') || p;
  const norm = (p: any) => p.replace(/[\\/]+$/, '');

  // Folder paths are stored relative to the workspace file when they live beneath it, so a
  // workspace checked into a repo works on every machine.
  function serialize(wsFile: any, roots: any) {
    const base = dirname(wsFile);
    const folders = roots.map((r: any) => {
      const rr = norm(r);
      return { path: rr.startsWith(base + '/') || rr.startsWith(base + '\\') ? './' + rr.slice(base.length + 1).replace(/\\/g, '/') : rr };
    });
    return JSON.stringify({ version: 1, folders }, null, 2) + '\n';
  }
  function parse(wsFile: any, text: any) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Workspace file is not valid JSON.'); }
    if (!data || !Array.isArray(data.folders) || !data.folders.length) throw new Error('Workspace file lists no folders.');
    const base = dirname(wsFile), sep = sepOf(wsFile);
    const out: any[] = [];
    for (const f of data.folders.slice(0, 50)) {
      const p = typeof f === 'string' ? f : f && f.path;
      if (typeof p !== 'string' || !p.trim()) continue;
      const abs = /^([a-zA-Z]:[\\/]|[\\/])/.test(p) ? norm(p) : norm(base + sep + p.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep));
      if (!out.includes(abs)) out.push(abs);
    }
    if (!out.length) throw new Error('Workspace file lists no usable folders.');
    return out;
  }
  const api = { serialize, parse, WS_EXT };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  (root as any).NexoWorkspace = api;

  // ---------- renderer integration ----------
  async function loadRoots(roots: any, wsFile: any) {
    const existing = [];
    for (const r of roots) if (await window.nexo.exists(r)) existing.push(r);
    if (!existing.length) { flashToast('None of the workspace folders exist.'); return; }
    if (existing.length < roots.length) flashToast(`${roots.length - existing.length} workspace folder(s) not found and skipped.`);
    state.roots = existing;
    await openProject(existing[0], { keepRoots: true });
    state.workspaceFile = wsFile || null;
    updateTitle();
    await renderTree();
  }
  function updateTitle() {
    if (state.roots.length > 1) {
      const name = state.workspaceFile ? state.workspaceFile.split(/[\\/]/).pop()!.replace(WS_EXT, '') : state.projectRoot!.split(/[\\/]/).pop() + ` (+${state.roots.length - 1})`;
      document.getElementById('project-name')!.textContent = name + ' (Workspace)';
      document.getElementById('sidebar-root-name')!.textContent = 'WORKSPACE';
    }
  }
  async function addFolder(folder?: any) {
    if (!folder) { folder = await window.nexo.pickFolder('Add Folder to Workspace'); if (!folder) return; }
    if (!state.projectRoot) { await openProject(folder); return; }
    if (state.roots.includes(folder)) { flashToast('That folder is already in the workspace.'); return; }
    if (!state.roots.length) state.roots = [state.projectRoot];
    state.roots.push(folder);
    state.expanded.add(folder);
    paletteState.filesCache = null;
    updateTitle();
    await renderTree();
  }
  async function removeRoot(folder: any) {
    if (state.roots.length <= 1) return;
    state.roots = state.roots.filter((r) => r !== folder);
    state.expanded.delete(folder);
    paletteState.filesCache = null;
    if (state.projectRoot === folder) await setActiveRoot(state.roots[0]);
    if (state.roots.length === 1) {
      const only = state.roots[0]; state.workspaceFile = null;
      document.getElementById('project-name')!.textContent = only.split(/[\\/]/).pop()!;
      document.getElementById('sidebar-root-name')!.textContent = only.split(/[\\/]/).pop()!.toUpperCase();
    } else updateTitle();
    await renderTree();
  }
  async function saveWorkspace() {
    if (state.roots.length < 1) { flashToast('Open a folder first.'); return; }
    let file = state.workspaceFile;
    if (!file) {
      file = await window.nexo.saveAsDialog('workspace' + WS_EXT);
      if (!file) return;
      if (!file.endsWith(WS_EXT)) file += WS_EXT;
    }
    const res = await window.nexo.writeFile(file, serialize(file, wsRootsList()));
    if (!res.ok) { alert('Could not save workspace:\n' + res.error); return; }
    state.workspaceFile = file; updateTitle();
    flashToast('Workspace saved: ' + file.split(/[\\/]/).pop());
  }
  const wsRootsList = () => (state.roots.length ? state.roots : [state.projectRoot]);
  async function openWorkspaceFile(file?: any) {
    if (!file) file = await window.nexo.pickFile('Open Workspace', [{ name: 'Nexo Workspace', extensions: ['nexo-workspace'] }]);
    if (!file) return;
    const r = await window.nexo.readFile(file);
    if (!r.ok) { alert('Could not read workspace:\n' + r.error); return; }
    let roots;
    try { roots = parse(file, r.content); } catch (e) { alert(e.message); return; }
    await loadRoots(roots, file);
  }

  window.removeWorkspaceRoot = removeRoot;
  window.nexoWorkspace = { addFolder, removeRoot, saveWorkspace, openWorkspaceFile, loadRoots };

  const fileMenu = APP_MENUS.file;
  const at = fileMenu.findIndex((i) => i.label === 'New File');
  fileMenu.splice(at, 0,
    { label: 'Open Workspace…', run: () => openWorkspaceFile() },
    { label: 'Add Folder to Workspace…', run: () => addFolder() },
    { label: 'Save Workspace As…', run: () => { state.workspaceFile = null; return saveWorkspace(); } },
    { separator: true });
  PALETTE_COMMANDS.push(
    { label: 'Workspace: Add Folder…', run: () => addFolder() },
    { label: 'Workspace: Open…', run: () => openWorkspaceFile() },
    { label: 'Workspace: Save', run: () => saveWorkspace() },
    { label: 'Workspace: Remove Active Folder', run: () => removeRoot(state.projectRoot) },
  );
  // Double-clicking a .nexo-workspace in the tree opens it as a workspace.
  document.addEventListener('dblclick', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
    if (row && row.dataset.path && row.dataset.path.endsWith(WS_EXT)) openWorkspaceFile(row.dataset.path);
  });
})(typeof window !== 'undefined' ? window : globalThis);
