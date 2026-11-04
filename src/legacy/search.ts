
// ---------------- Global search ----------------
let searchDebounceTimer: any = null;
function validateSearchRegex() {
  const useRegex = document.getElementById('search-regex')!.checked;
  const errBox = document.getElementById('search-regex-error');
  if (!useRegex) { errBox!.classList.add('hidden'); return true; }
  const query = document.getElementById('search-input')!.value;
  if (!query) { errBox!.classList.add('hidden'); return true; }
  try {
    new RegExp(query);
    errBox!.classList.add('hidden');
    return true;
  } catch (err) {
    errBox!.textContent = `Invalid regex: ${err.message}`;
    errBox!.classList.remove('hidden');
    return false;
  }
}

async function runSearch() {
  const query = document.getElementById('search-input')!.value;
  const summary = document.getElementById('search-summary');
  const results = document.getElementById('search-results');
  if (!state.projectRoot) {
    summary!.textContent = 'Open a folder to search its files.';
    results!.innerHTML = '';
    return;
  }
  if (!query.trim()) {
    summary!.textContent = '';
    results!.innerHTML = '';
    return;
  }
  if (!validateSearchRegex()) {
    summary!.textContent = '';
    results!.innerHTML = '';
    return;
  }
  summary!.textContent = 'Searching…';
  const caseSensitive = document.getElementById('search-case')!.checked;
  const useRegex = document.getElementById('search-regex')!.checked;
  const res = await searchAllRoots(query, { caseSensitive, useRegex });
  if (res.error) {
    summary!.textContent = '';
    results!.innerHTML = '';
    const errBox = document.getElementById('search-regex-error');
    errBox!.textContent = `Invalid regex: ${res.error}`;
    errBox!.classList.remove('hidden');
    return;
  }
  renderSearchResults(res, query);
}

async function searchAllRoots(query: any, opts: any) {
  const roots = wsRoots();
  if (roots.length <= 1) return window.nexo.searchText(state.projectRoot, query, opts);
  const all = await Promise.all(roots.map((r) => window.nexo.searchText(r, query, opts)));
  const bad = all.find((r) => r && r.error);
  if (bad) return bad;
  const merged = { ...all[0], matches: all.flatMap((r) => r.matches || []) };
  for (const k of Object.keys(all[0] || {})) if (typeof all[0][k] === 'number') merged[k] = all.reduce((n, r) => n + (r[k] || 0), 0);
  return merged;
}

function highlightMatch(text: any, query: any, caseSensitive: any) {
  const idx = caseSensitive ? text.indexOf(query) : text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx)) + '<mark>' + escapeHtml(text.slice(idx, idx + query.length)) + '</mark>' + escapeHtml(text.slice(idx + query.length));
}

function renderSearchResults(res: any, query: any) {
  const summary = document.getElementById('search-summary');
  const container = document.getElementById('search-results');
  container!.innerHTML = '';
  const totalMatches = res.matches.reduce((sum: any, f: any) => sum + f.matches.length, 0);
  if (!res.matches.length) {
    summary!.textContent = 'No results found.';
    return;
  }
  summary!.textContent = `${totalMatches} result${totalMatches === 1 ? '' : 's'} in ${res.matches.length} file${res.matches.length === 1 ? '' : 's'}${res.truncated ? ' (truncated)' : ''}`;
  const caseSensitive = document.getElementById('search-case')!.checked;

  for (const fileResult of res.matches) {
    const group = document.createElement('div');
    group.className = 'search-file-group';
    const relName = displayRel(fileResult.path);

    const header = document.createElement('div');
    header.className = 'search-file-header';
    header.innerHTML = `<span class="ficon">${fileIcon(fileResult.path.split(/[\\/]/).pop(), false)}</span><span>${escapeHtml(relName)}</span><span class="count">${fileResult.matches.length}</span>`;
    group.appendChild(header);

    const rowsBox = document.createElement('div');
    for (const m of fileResult.matches) {
      const row = document.createElement('div');
      row.className = 'search-match-row';
      row.innerHTML = `<span class="lineno">${m.line}:</span>${highlightMatch(m.preview, query, caseSensitive)}`;
      row.addEventListener('click', async () => {
        await openFile(fileResult.path);
        if (editor) {
          editor.revealLineInCenter(m.line);
          editor.setPosition({ lineNumber: m.line, column: m.col });
          editor.focus();
        }
      });
      rowsBox.appendChild(row);
    }
    group.appendChild(rowsBox);
    header.addEventListener('click', () => rowsBox.classList.toggle('collapsed'));
    container!.appendChild(group);
  }
}

document.getElementById('search-input')!.addEventListener('input', () => {
  validateSearchRegex();
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(runSearch, 300);
});
document.getElementById('search-case')!.addEventListener('change', runSearch);
document.getElementById('search-regex')!.addEventListener('change', () => { validateSearchRegex(); runSearch(); });

document.getElementById('btn-toggle-replace')!.addEventListener('click', (e) => {
  const row = document.getElementById('replace-row');
  const show = row!.classList.contains('hidden');
  row!.classList.toggle('hidden', !show);
  e.currentTarget!.classList.toggle('on', show);
  if (show) document.getElementById('replace-input')!.focus();
});

document.getElementById('btn-replace-all')!.addEventListener('click', async () => {
  const query = document.getElementById('search-input')!.value;
  const replacement = document.getElementById('replace-input')!.value;
  if (!query.trim()) return;
  if (!state.projectRoot) { alert('Open a folder first.'); return; }
  if (!validateSearchRegex()) return;
  const caseSensitive = document.getElementById('search-case')!.checked;
  const useRegex = document.getElementById('search-regex')!.checked;

  const ok = confirm(`Replace all occurrences of "${query}" with "${replacement}" across the project?\n\nThis rewrites matching files directly — it cannot be undone by this app (though your own version control can still help if the project is a git repo).`);
  if (!ok) return;

  const btn = document.getElementById('btn-replace-all');
  btn!.disabled = true;
  btn!.textContent = 'Replacing…';
  let res;
  try {
    res = await window.nexo.replaceAll(state.projectRoot, query, replacement, { caseSensitive, useRegex });
  } finally {
    btn!.disabled = false;
    btn!.textContent = 'Replace All';
  }

  if (res.errors.length && res.filesChanged === 0 && res.totalReplacements === 0 && res.errors[0].path === '') {
    const errBox = document.getElementById('search-regex-error');
    errBox!.textContent = res.errors[0].error;
    errBox!.classList.remove('hidden');
    return;
  }

  document.getElementById('search-summary')!.textContent =
    `Replaced ${res.totalReplacements} occurrence${res.totalReplacements === 1 ? '' : 's'} in ${res.filesChanged} file${res.filesChanged === 1 ? '' : 's'}` +
    (res.errors.length ? ` (${res.errors.length} failed)` : '');
  document.getElementById('search-results')!.innerHTML = '';

  // Any changed files that happen to be open need their editor content
  // refreshed — reuse the same silent-reload path as external file changes,
  // since that's exactly what this is (the disk content just changed).
  for (const p of res.changedPaths) {
    const tab = state.openTabs.find((t) => t.path === p);
    if (!tab) continue;
    const fresh = await window.nexo.readFile(p);
    if (!fresh.ok) continue;
    const isActiveModel = editor && editor.getModel() === tab.model;
    const viewState = isActiveModel ? editor.saveViewState() : null;
    tab.model.setValue(fresh.content);
    tab.byteLength = fresh.content.length;
    tab.modified = false;
    if (isActiveModel && viewState) editor.restoreViewState(viewState);
    if (tab.isMarkdown && tab.mdMode === 'preview') renderMarkdownPreview(tab);
  }
  if (res.changedPaths.length) renderTabs();
});
