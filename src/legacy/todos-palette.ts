
// ---------------- TODO / FIXME comments panel ----------------
let todosState: any = { todos: null, error: null, loading: false };

async function loadTodos() {
  const box = document.getElementById('todos-list');
  if (!state.projectRoot) { todosState = { todos: null, error: 'Open a folder first.', loading: false }; renderTodosPanel(); return; }
  todosState = { todos: null, error: null, loading: true };
  renderTodosPanel();
  const parts = await Promise.all(wsRoots().map((r) => window.nexo.scanTodos(r)));
  const res = parts.find((r) => !r.ok) || { ok: true, todos: parts.flatMap((r) => r.todos), truncated: parts.some((r) => r.truncated) };
  if (!res.ok) { todosState = { todos: null, error: res.error || 'Could not scan for TODOs.', loading: false }; renderTodosPanel(); return; }
  todosState = { todos: res.todos, error: null, loading: false, truncated: res.truncated };
  renderTodosPanel();
}

const TODO_TAG_CLASS: any = { TODO: 'todo-tag-todo', FIXME: 'todo-tag-fixme', HACK: 'todo-tag-hack' };

function renderTodosPanel() {
  const box = document.getElementById('todos-list');
  if (!box) return;
  if (todosState.loading) { box.innerHTML = '<div id="scripts-empty">Scanning project…</div>'; return; }
  if (todosState.error) { box.innerHTML = `<div id="scripts-empty">${escapeHtml(todosState.error)}</div>`; return; }
  const todos = todosState.todos || [];
  if (!todos.length) { box.innerHTML = '<div id="scripts-empty">No TODO, FIXME, or HACK comments found.</div>'; return; }
  const rootSep = state.projectRoot!.includes('\\') ? '\\' : '/';
  box.innerHTML = (todosState.truncated ? '<div id="scripts-empty">Showing a partial scan — this is a large project.</div>' : '') + todos.map((t: any) => {
    const rel = displayRel(t.path);
    return `
      <div class="todo-row" data-path="${escapeHtml(t.path)}" data-line="${t.line}">
        <span class="todo-tag ${TODO_TAG_CLASS[t.tag] || 'todo-tag-todo'}">${escapeHtml(t.tag)}</span>
        <div class="todo-row-main">
          <div class="todo-row-text">${escapeHtml(t.text || '(no message)')}</div>
          <div class="todo-row-loc">${escapeHtml(rel)}:${t.line}</div>
        </div>
      </div>`;
  }).join('');
  box.querySelectorAll('.todo-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const path = row.dataset.path;
      const line = parseInt(row.dataset.line, 10);
      await openFile(path);
      if (editor && editor.getModel() && state.activeTab === path) {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      }
    });
  });
}

document.getElementById('btn-todos-refresh')!.addEventListener('click', loadTodos);

// ---------------- Command Palette / Quick Open ----------------
const paletteState: any = { mode: 'files', items: [], active: 0, filesCache: null };

const PALETTE_COMMANDS: any[] = [
  { label: 'Open Folder…', run: handleOpenFolder },
  { label: 'New File', run: handleNewFile },
  { label: 'Save', shortcut: 'Ctrl+S', run: saveActiveTab },
  { label: 'Save As…', run: saveActiveTabAs },
  { label: 'Find in Files', shortcut: 'Ctrl+Shift+F', run: () => switchRailView('search') },
  { label: 'Source Control', run: () => switchRailView('git') },
  { label: 'npm Scripts', run: () => switchRailView('scripts') },
  { label: 'Python: Debug Current File', run: () => startDebug() },
  { label: 'Python: Run Current File', run: () => runPythonFile() },
  { label: 'Python: Run Current File (dev mode, unbuffered)', run: () => runPythonFile(true) },
  { label: 'Python Environments', run: () => switchRailView('python') },
  { label: 'Outline', run: () => switchRailView('outline') },
  { label: 'Format Document', run: formatActiveDocument },
  { label: 'Show TODOs / FIXMEs', run: () => switchRailView('todos') },
  { label: 'Settings', run: () => switchRailView('settings') },
  { label: 'GitHub', run: () => switchRailView('github') },
  { label: 'Browse GitHub Repos…', run: openGithubRepoPicker },
  { label: 'Create GitHub Repo…', run: handleCreateGithubRepo },
  { label: 'Create GitHub Release…', run: () => { switchRailView('github'); githubPanelState.subtab = 'releases'; renderGithubPanel(); openCreateReleaseForm(); } },
  { label: 'Set Up Cloudflare Pages Deploy…', run: handleSetupCloudflareDeploy },
  { label: 'Open Project Settings (.nexo/settings.json)', run: handleOpenProjectSettings },
  { label: "Save Current Settings as Project Override", run: handleSaveCurrentAsProjectSettings },
  { label: 'Toggle Terminal', shortcut: 'Ctrl+`', run: () => toggleTerminal() },
  { label: 'Toggle Split Editor', shortcut: 'Ctrl+\\', run: () => toggleSplit() },
  { label: 'Toggle Zen Mode', run: () => toggleZenMode() },
  { label: 'Toggle Sidebar', run: () => { const sb = document.getElementById('sidebar'); sb!.style.display = sb!.style.display === 'none' ? 'flex' : 'none'; } },
  { label: 'Check for Updates…', run: () => window.nexo.checkForUpdates(true) },
];

async function openPalette(mode: any) {
  const overlay = document.getElementById('palette-overlay');
  const input = document.getElementById('palette-input');
  paletteState.mode = mode;
  overlay!.classList.remove('hidden');
  input!.value = mode === 'commands' ? '>' : '';
  input!.placeholder = mode === 'github-repos' ? 'Search your GitHub repos…' : 'Search files… (type > for commands)';
  if (mode === 'files' && state.projectRoot) {
    if (!paletteState.filesCache) {
      const lists = await Promise.all(wsRoots().map((r) => window.nexo.listFiles(r)));
      paletteState.filesCache = lists.flatMap((r) => (r && r.files) || []);
    }
    paletteState.recentFiles = await window.nexo.getRecentFiles();
  }
  if (mode === 'github-repos') {
    const status = await window.nexo.hasGithubToken();
    if (!status.hasToken) {
      closePalette();
      alert('Connect a GitHub token in Settings first.');
      return;
    }
    document.getElementById('palette-empty')!.textContent = 'Loading your repos…';
    document.getElementById('palette-empty')!.classList.remove('hidden');
    document.getElementById('palette-list')!.innerHTML = '';
    const res = await window.nexo.listGithubRepos();
    if (!res.ok) {
      closePalette();
      alert(`Could not load GitHub repos:\n${res.error}`);
      return;
    }
    paletteState.githubRepos = res.repos;
  }
  renderPaletteResults();
  input!.focus();
  input!.select();
}

function closePalette() {
  document.getElementById('palette-overlay')!.classList.add('hidden');
}

async function openRecentFile(entry: any) {
  if (entry.projectRoot && entry.projectRoot !== state.projectRoot) {
    const exists = await window.nexo.exists(entry.projectRoot);
    if (!exists) { alert(`That project folder no longer exists:\n${entry.projectRoot}`); return; }
    await openProject(entry.projectRoot);
  }
  openFile(entry.path);
}

// Ranked fuzzy scoring: consecutive runs, word-start and basename hits score
// higher. Returns -1 for no match. Used to sort results best-first.
function paletteScore(query: any, text: any) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const base = t.slice(Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) + 1);
  const exact = base.indexOf(q);
  if (exact !== -1) return 1000 - exact - base.length * 0.1 + (exact === 0 ? 200 : 0);
  let qi = 0, score = 0, run = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      run++;
      score += 1 + run * 2 + (i === 0 || /[\s/\\._-]/.test(t[i - 1]) ? 6 : 0);
      qi++;
    } else run = 0;
  }
  return qi === q.length ? score - t.length * 0.05 : -1;
}
function paletteHighlight(text: any, query: any) {
  if (!query) return escapeHtml(text);
  const q = query.toLowerCase();
  const idx = text.toLowerCase().indexOf(q);
  if (idx !== -1) return escapeHtml(text.slice(0, idx)) + '<mark>' + escapeHtml(text.slice(idx, idx + q.length)) + '</mark>' + escapeHtml(text.slice(idx + q.length));
  let qi = 0, out = '';
  for (const ch of text) {
    if (qi < q.length && ch.toLowerCase() === q[qi]) { out += '<mark>' + escapeHtml(ch) + '</mark>'; qi++; }
    else out += escapeHtml(ch);
  }
  return out;
}
function paletteRank(list: any, query: any, getText: any) {
  if (!query) return list;
  return list.map((x: any) => ({ x, s: paletteScore(query, getText(x)) })).filter((r: any) => r.s >= 0).sort((a: any, b: any) => b.s - a.s).map((r: any) => r.x);
}
function paletteRecentCmds() { try { return JSON.parse(localStorage.getItem('nexo.recentCmds') || '[]'); } catch { return []; } }
function paletteNoteCmd(label: any) {
  try { localStorage.setItem('nexo.recentCmds', JSON.stringify([label, ...paletteRecentCmds().filter((l: any) => l !== label)].slice(0, 8))); } catch { /* storage unavailable */ }
}

function paletteFuzzyMatch(query: any, text: any) {
  if (!query) return true;
  let qi = 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function renderPaletteResults() {
  const raw = document.getElementById('palette-input')!.value;
  const isCommand = raw.startsWith('>');
  const query = isCommand ? raw.slice(1).trim() : raw.trim();

  let items = [];
  if (paletteState.mode === 'github-repos') {
    const repos = paletteState.githubRepos || [];
    items = repos
      .filter((r: any) => paletteFuzzyMatch(raw.trim(), r.fullName))
      .slice(0, 200)
      .map((r: any) => ({
        label: r.fullName,
        meta: r.private ? 'private' : 'public',
        icon: '📦',
        run: () => continueCloneFlow(r.cloneUrl),
      }));
  } else if (isCommand) {
    const recent = paletteRecentCmds();
    let cmds = paletteRank(PALETTE_COMMANDS, query, (c: any) => c.label);
    if (!query) cmds = [...cmds].sort((a, b) => (recent.indexOf(a.label) + 100) % 100 - (recent.indexOf(b.label) + 100) % 100);
    items = cmds.map((c: any) => ({
      label: c.label, meta: c.shortcut || (!query && recent.includes(c.label) ? 'recent' : ''), icon: '⚡',
      run: () => { paletteNoteCmd(c.label); return c.run(); },
    }));
  } else if (state.projectRoot) {
    if (!query) {
      const recents = paletteState.recentFiles || [];
      items = recents.slice(0, 30).map((f: any) => {
        const inCurrentProject = f.projectRoot === state.projectRoot;
        const meta = inCurrentProject
          ? (f.path.startsWith(state.projectRoot) ? f.path.slice(state.projectRoot!.length + 1) : f.path)
          : `in ${f.projectRoot ? f.projectRoot.split(/[\\/]/).pop() : '?'}`;
        return { label: f.path.split(/[\\/]/).pop(), meta, icon: fileIcon(f.path, false), run: () => openRecentFile(f) };
      });
    } else {
      const files = paletteState.filesCache || [];
      items = paletteRank(files, query, (f: any) => f)
        .slice(0, 200)
        .map((f: any) => ({ label: f.split(/[\\/]/).pop(), meta: f, icon: fileIcon(f, false), run: () => openFile(f) }));
    }
  }

  paletteState.items = items;
  paletteState.active = 0;
  const list = document.getElementById('palette-list');
  const empty = document.getElementById('palette-empty');
  if (!items.length) {
    list!.innerHTML = '';
    empty!.classList.remove('hidden');
    empty!.textContent = state.projectRoot || isCommand ? 'No matches.' : 'Open a folder to search its files.';
    return;
  }
  empty!.classList.add('hidden');
  list!.innerHTML = items.map((it: any, i: any) => `
    <div class="palette-item ${i === 0 ? 'active' : ''}" data-idx="${i}">
      <span class="palette-icon">${it.icon || ''}</span>
      <span class="palette-label">${paletteHighlight(it.label, isCommand || paletteState.mode !== 'files' ? query : query)}</span>
      ${it.meta ? `<span class="palette-meta">${escapeHtml(it.meta)}</span>` : ''}
    </div>`).join('');
  list!.querySelectorAll('.palette-item').forEach((el) => {
    el.addEventListener('click', () => runPaletteItem(parseInt(el.dataset.idx, 10)));
  });
}

function runPaletteItem(idx: any) {
  const item = paletteState.items[idx];
  if (!item) return;
  closePalette();
  item.run();
}

function setPaletteActive(idx: any) {
  const list = document.getElementById('palette-list');
  const rows = list!.querySelectorAll('.palette-item');
  if (!rows.length) return;
  paletteState.active = Math.max(0, Math.min(idx, rows.length - 1));
  rows.forEach((r, i) => r.classList.toggle('active', i === paletteState.active));
  rows[paletteState.active].scrollIntoView({ block: 'nearest' });
}

document.getElementById('palette-input')!.addEventListener('input', renderPaletteResults);
document.getElementById('palette-input')!.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteActive(paletteState.active + 1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteActive(paletteState.active - 1); return; }
  if (e.key === 'Enter') { e.preventDefault(); runPaletteItem(paletteState.active); }
});
document.getElementById('palette-overlay')!.addEventListener('mousedown', (e) => {
  if (e.target!.id === 'palette-overlay') closePalette();
});
