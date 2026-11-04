
// ---------------- Toolbar / menu wiring ----------------
let openInProgress = false;
async function handleOpenFolder() {
  if (openInProgress) return;
  openInProgress = true;
  try {
    const res = await window.nexo.openFolder();
    if (res) await openProject(res.folder);
  } finally {
    openInProgress = false;
  }
}
async function handleNewProject() {
  if (openInProgress) return;
  openInProgress = true;
  try {
    const res = await window.nexo.newProject();
    if (res) await openProject(res.folder);
  } finally {
    openInProgress = false;
  }
}
function handleNewFile() {
  if (!state.projectRoot) { alert('Open a folder first.'); return; }
  promptNewFile(state.projectRoot);
}

function handleCloneRepo() {
  showModal({
    title: 'Clone Repository',
    fields: [{ id: 'url', placeholder: 'https://github.com/user/repo.git' }],
    confirmLabel: 'Next',
    onConfirm: ({ url }: any): any => {
      // Deferred so the destination-folder dialog doesn't pop up stacked on
      // top of this modal while it's still closing.
      setTimeout(() => continueCloneFlow(url.trim()), 50);
      return null;
    },
  });
}

async function continueCloneFlow(url: any) {
  if (openInProgress) return;
  const parent = await window.nexo.pickFolder('Choose where to clone this repository');
  if (!parent) return;
  openInProgress = true;
  showUpdateToast('Cloning repository…', []);
  try {
    const res = await window.nexo.cloneRepo(url, parent);
    if (!res.ok) { alert(`Clone failed:\n${res.error}`); return; }
    await openProject(res.path);
  } finally {
    hideUpdateToast();
    openInProgress = false;
  }
}

document.getElementById('btn-open-folder')!.addEventListener('click', handleOpenFolder);
document.getElementById('welcome-open')!.addEventListener('click', handleOpenFolder);
document.getElementById('welcome-new')!.addEventListener('click', handleNewProject);
document.getElementById('welcome-clone')!.addEventListener('click', handleCloneRepo);
document.getElementById('welcome-github-repos')!.addEventListener('click', openGithubRepoPicker);
document.getElementById('welcome-github-create')!.addEventListener('click', handleCreateGithubRepo);

function openGithubRepoPicker() {
  paletteState.githubRepos = null; // force a fresh fetch each time
  openPalette('github-repos');
}

function handleCreateGithubRepo() {
  window.nexo.hasGithubToken().then((status) => {
    if (!status.hasToken) { alert('Connect a GitHub token in Settings first.'); return; }
    showModal({
      title: 'Create GitHub Repository',
      fields: [
        { id: 'name', placeholder: 'my-new-repo' },
        { id: 'description', placeholder: 'Description (optional)', required: false },
      ],
      confirmLabel: 'Next',
      onConfirm: ({ name, description }: any) => {
        if (!name.trim()) return 'Repository name is required.';
        setTimeout(() => continueCreateGithubRepoFlow(name.trim(), description.trim()), 50);
        return null;
      },
    });
  });
}

async function continueCreateGithubRepoFlow(name: any, description: any) {
  const isPrivate = confirm('Make this repository private?\n\nOK = private, Cancel = public');
  showUpdateToast('Creating repository…', []);
  try {
    const res = await window.nexo.createGithubRepo({ name, description, isPrivate });
    if (!res.ok) { alert(`Could not create repository:\n${res.error}`); return; }
    const cloneNow = confirm(`Created ${res.repo.fullName} on GitHub.\n\nClone it locally now?`);
    if (cloneNow) continueCloneFlow(res.repo.cloneUrl);
  } finally {
    hideUpdateToast();
  }
}
document.getElementById('btn-new-file')!.addEventListener('click', handleNewFile);
document.getElementById('btn-add-file')!.addEventListener('click', () => state.projectRoot && promptNewFile(state.projectRoot));
document.getElementById('btn-add-folder')!.addEventListener('click', () => state.projectRoot && promptNewFolder(state.projectRoot));
document.getElementById('btn-toggle-ignored')!.addEventListener('click', async () => {
  state.showIgnored = !state.showIgnored;
  document.getElementById('btn-toggle-ignored')!.classList.toggle('on', state.showIgnored);
  document.getElementById('btn-toggle-ignored')!.title = state.showIgnored
    ? 'Hide files matched by .gitignore'
    : 'Show files matched by .gitignore';
  await refreshIgnoredPaths();
  await renderTree();
});

document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveActiveTabAs(); return; }
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); saveActiveTab(); }
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); handleOpenFolder(); }
  if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); handleNewFile(); }
  if (ctrl && e.key.toLowerCase() === 'w' && state.activeTab) { e.preventDefault(); closeTab(state.activeTab); }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); switchRailView('search'); }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); switchRailView('git'); }
  if (e.key === 'F5' && ctrl) { e.preventDefault(); runPythonFile(); }
  else if (e.key === 'F5' && e.shiftKey) { e.preventDefault(); dbgApi().stop(); }
  else if (e.key === 'F5') { e.preventDefault(); if (dbg.active) dbgControl('continue'); else startDebug(); }
  if (e.key === 'F10') { e.preventDefault(); dbgControl('next'); }
  if (e.key === 'F11') { e.preventDefault(); dbgControl(e.shiftKey ? 'stepOut' : 'stepIn'); }
  if (ctrl && e.key === '`') { e.preventDefault(); toggleTerminal(); }
  if (ctrl && e.key === '\\') { e.preventDefault(); toggleSplit(); }
  if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); changeFontSize(1); }
  if (ctrl && e.key === '-') { e.preventDefault(); changeFontSize(-1); }
  if (ctrl && e.key === '0') { e.preventDefault(); resetFontSize(); }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); reopenClosedTab(); }
  if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openPalette('files'); }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openPalette('commands'); }
  if (e.shiftKey && e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); formatActiveDocument(); }
  if (e.key === 'Escape' && document.body.classList.contains('zen-mode')) { toggleZenMode(false); }
  if (ctrl && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    const sb = document.getElementById('sidebar');
    sb!.style.display = sb!.style.display === 'none' ? 'flex' : 'none';
  }
});

if (window.nexo.onMenu) {
  window.nexo.onMenu('menu:open-folder', handleOpenFolder);
  window.nexo.onMenu('menu:new-file', handleNewFile);
  window.nexo.onMenu('menu:save', saveActiveTab);
  window.nexo.onMenu('menu:save-as', saveActiveTabAs);
  window.nexo.onMenu('menu:show-search', () => switchRailView('search'));
  window.nexo.onMenu('menu:show-git', () => switchRailView('git'));
  window.nexo.onMenu('menu:toggle-terminal', () => toggleTerminal());
  window.nexo.onMenu('menu:toggle-split', () => toggleSplit());
  window.nexo.onMenu('menu:toggle-zen', () => toggleZenMode());
  window.nexo.onMenu('menu:toggle-sidebar', () => {
    const sb = document.getElementById('sidebar');
    sb!.style.display = sb!.style.display === 'none' ? 'flex' : 'none';
  });
}

if (window.nexo.onFileChanged) {
  window.nexo.onFileChanged(async (filePath: any) => {
    const tab = state.openTabs.find((t) => t.path === filePath);
    if (!tab) return; // not open anymore (or watcher hadn't been stopped yet)
    if (tab.modified) {
      const reload = confirm(`"${tab.name}" changed on disk (outside Nexo Dev).\n\nYou have unsaved changes here. Reload from disk and lose them, or keep your version?`);
      if (!reload) return;
    }
    const res = await window.nexo.readFile(filePath);
    if (!res.ok) return;
    const viewState = (editor && editor.getModel() === tab.model) ? editor.saveViewState() : null;
    tab.model.setValue(res.content);
    tab.byteLength = res.content.length;
    tab.modified = false;
    renderTabs();
    if (viewState && editor) editor.restoreViewState(viewState);
    if (tab.isMarkdown && tab.mdMode === 'preview') renderMarkdownPreview(tab);
  });
}

// ---------------- Auto-update ----------------
function showUpdateToast(text: any, actions: any) {
  const toast = document.getElementById('update-toast');
  document.getElementById('update-toast-text')!.textContent = text;
  const actionsBox = document.getElementById('update-toast-actions');
  actionsBox!.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement('button');
    if (a.primary) btn.className = 'primary';
    btn.textContent = a.label;
    btn.addEventListener('click', a.onClick);
    actionsBox!.appendChild(btn);
  }
  toast!.classList.remove('hidden');
}
function hideUpdateToast() { document.getElementById('update-toast')!.classList.add('hidden'); }

let flashToastTimer: any = null;
function flashToast(text: string) {
  showUpdateToast(text, [{ label: 'Dismiss', onClick: hideUpdateToast }]);
  clearTimeout(flashToastTimer);
  flashToastTimer = setTimeout(hideUpdateToast, 4000);
}

if (window.nexo.onUpdateAvailable) {
  window.nexo.onUpdateAvailable((version: any) => {
    showUpdateToast(`Nexo Dev ${version} is available.`, [
      { label: 'Download', primary: true, onClick: () => {
        window.nexo.downloadUpdate();
        showUpdateToast('Downloading update… 0%', []);
      } },
      { label: 'Dismiss', onClick: hideUpdateToast },
    ]);
  });
}
if (window.nexo.onUpdateNotAvailable) {
  window.nexo.onUpdateNotAvailable(() => {
    showUpdateToast("You're on the latest version.", [{ label: 'OK', primary: true, onClick: hideUpdateToast }]);
  });
}
if (window.nexo.onUpdateProgress) {
  window.nexo.onUpdateProgress((percent: any) => {
    showUpdateToast(`Downloading update… ${Math.round(percent)}%`, []);
  });
}
if (window.nexo.onUpdateDownloaded) {
  window.nexo.onUpdateDownloaded(() => {
    showUpdateToast('Update downloaded. Restart to install it.', [
      { label: 'Restart Now', primary: true, onClick: () => window.nexo.installUpdate() },
      { label: 'Later', onClick: hideUpdateToast },
    ]);
  });
}
if (window.nexo.onUpdateError) {
  window.nexo.onUpdateError((message: any) => {
    showUpdateToast(`Update check failed: ${message}`, [{ label: 'OK', primary: true, onClick: hideUpdateToast }]);
  });
}
if (window.nexo.onMenu) {
  window.nexo.onMenu('menu:check-updates', () => window.nexo.checkForUpdates(true));
}

window.addEventListener('beforeunload', (e) => {
  const dirty = state.openTabs.some((t) => t.modified);
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});
