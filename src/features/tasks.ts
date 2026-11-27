// Tasks runner + Problems panel. Tasks come from package.json scripts, .nexo/tasks.json and .vscode/tasks.json;
// problems come from Monaco markers (LSP / ESLint / Python lint) and from parsing task output.
(function () {
  const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
  const el = (tag: string, props: Record<string, any> = {}, ...kids: any[]) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v as any); else n.setAttribute(k, String(v));
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  };
  const T = () => window.NexoTasks;
  const SEV_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const ts: any = { running: null, output: '', taskProblems: [], tasks: [], lastTask: null, view: null };

  async function readJson(rel: string, jsonc = false) {
    if (!state.projectRoot) return null;
    const sep = state.projectRoot.includes('\\') ? '\\' : '/';
    const r = await window.nexo.readFile(state.projectRoot + sep + rel.replace(/\//g, sep));
    if (!r.ok) return null;
    try { return jsonc ? T().parseJsonc(r.content) : JSON.parse(r.content); } catch { return null; }
  }
  async function detectPm() {
    const root = state.projectRoot!, sep = root.includes('\\') ? '\\' : '/';
    for (const [file, pm] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun']] as const) if (await window.nexo.exists(root + sep + file)) return pm;
    return 'npm';
  }
  async function loadTasks() {
    if (!state.projectRoot) { ts.tasks = []; return ts.tasks; }
    ts.tasks = T().detectTasks({ packageJson: await readJson('package.json'), packageManager: await detectPm(), nexoTasks: await readJson('.nexo/tasks.json', true), vscodeTasks: await readJson('.vscode/tasks.json', true) });
    return ts.tasks;
  }

  // ---------- problems ----------
  const SEV_NAME: Record<number, string> = { 8: 'error', 4: 'warning', 2: 'info', 1: 'info' };
  function editorProblems() {
    const out: any[] = [];
    if (!window.monaco) return out;
    for (const tab of state.openTabs) {
      if (!tab.model) continue;
      for (const m of monaco.editor.getModelMarkers({ resource: tab.model.uri })) {
        out.push({ file: tab.path, line: m.startLineNumber, col: m.startColumn, severity: SEV_NAME[m.severity] || 'info', message: m.message, source: m.owner });
      }
    }
    return out;
  }
  const allProblems = () => [...editorProblems(), ...ts.taskProblems.map((p: any) => ({ ...p, source: 'task' }))]
    .sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line);

  async function goTo(file: string, line: number, col: number) {
    const ok = await openFile(file);
    if (ok === false || !editor) return;
    editor.setPosition({ lineNumber: line, column: col || 1 });
    editor.revealLineInCenter(line);
    editor.focus();
  }

  let statusEl: HTMLElement | null = null;
  function paintStatus() {
    const p = allProblems();
    const e = p.filter((x) => x.severity === 'error').length, w = p.filter((x) => x.severity === 'warning').length;
    if (!statusEl) {
      statusEl = el('span', { id: 'status-problems', title: 'Problems (click to open)', onclick: () => switchRailView('problems') });
      statusEl.style.cursor = 'pointer';
      $('#status-right').prepend(statusEl);
    }
    statusEl.textContent = `⊗ ${e}  ⚠ ${w}`;
    const badge = document.getElementById('rail-problems');
    if (badge) badge.title = `Problems: ${e} errors, ${w} warnings`;
  }

  function renderProblems() {
    paintStatus();
    if (!ts.view || !ts.view.isConnected) return;
    const list = ts.view.querySelector('#problems-list') as HTMLElement;
    const filter = (ts.view.querySelector('#problems-filter') as HTMLSelectElement).value;
    const p = allProblems().filter((x) => filter === 'all' || x.severity === filter);
    const rows: any[] = [];
    if (!p.length) rows.push(el('div', { class: 'db-note', text: 'No problems detected.' }));
    let lastFile = '';
    for (const x of p) {
      if (x.file !== lastFile) {
        lastFile = x.file;
        const rel = state.projectRoot && x.file.startsWith(state.projectRoot) ? x.file.slice(state.projectRoot.length).replace(/^[\\/]/, '') : x.file;
        rows.push(el('div', { class: 'http-pane-title', text: rel }));
      }
      rows.push(el('div', { class: 'http-hist-item problem-row', title: x.message, onclick: () => goTo(x.file, x.line, x.col) },
        el('span', { class: `problem-sev sev-${x.severity}`, text: x.severity === 'error' ? '⊗' : x.severity === 'warning' ? '⚠' : 'ⓘ' }),
        el('span', { class: 'http-hu', text: `${x.message}  [${x.line}:${x.col}]` }),
        el('span', { class: 'db-note', text: x.source })));
    }
    list.replaceChildren(...rows);
  }

  // ---------- running ----------
  function appendOutput(text: string) {
    ts.output = (ts.output + text).slice(-400000);
    const pre = ts.view && ts.view.querySelector('#tasks-output');
    if (pre) { pre.textContent = T().stripAnsi(ts.output); pre.scrollTop = pre.scrollHeight; }
  }
  async function runTask(task: any) {
    if (ts.running) { flashToast('A task is already running — stop it first.'); return; }
    if (!state.projectRoot) { flashToast('Open a folder first.'); return; }
    ts.lastTask = task; ts.output = ''; ts.taskProblems = [];
    switchRailView('problems');
    appendOutput(`> ${task.command}\n`);
    const r = await window.nexo.runCommand(state.projectRoot, task.command);
    if (!r || !r.id) { appendOutput(`[error] ${(r && r.error) || 'could not start'}\n`); return; }
    ts.running = { id: r.id, task };
    updateButtons();
  }
  function stopTask() { if (ts.running) window.nexo.killCommand(ts.running.id); }
  window.nexo.onTermData((id: any, chunk: any) => { if (ts.running && ts.running.id === id) appendOutput(chunk); });
  window.nexo.onTermExit((id: any, code: any) => {
    if (!ts.running || ts.running.id !== id) return;
    const task = ts.running.task;
    ts.running = null;
    ts.taskProblems = T().parseProblems(ts.output.split('\n').slice(1).join('\n'), state.projectRoot, task.matcher) // first line is our own command echo;
    appendOutput(`\n[${task.label} exited with code ${code}] — ${ts.taskProblems.length} problem(s) found\n`);
    updateButtons(); renderProblems();
    flashToast(code === 0 ? `Task "${task.label}" finished.` : `Task "${task.label}" failed (exit ${code}).`);
  });

  function updateButtons() {
    if (!ts.view) return;
    (ts.view.querySelector('#tasks-run') as HTMLButtonElement).disabled = !!ts.running;
    (ts.view.querySelector('#tasks-stop') as HTMLButtonElement).disabled = !ts.running;
  }

  async function pickTask(): Promise<any> {
    const tasks = await loadTasks();
    if (!tasks.length) { flashToast('No tasks found (package.json scripts, .nexo/tasks.json or .vscode/tasks.json).'); return null; }
    return new Promise((resolve) => {
      const overlay = el('div', { id: 'task-picker', class: 'lsp-status-dialog', role: 'dialog', 'aria-label': 'Run Task' });
      const card = el('div', { class: 'lsp-status-card' }, el('h3', { text: 'Run Task' }));
      const list = el('div', { class: 'lsp-status-scroll' });
      const done = (t: any) => { overlay.remove(); resolve(t); };
      for (const t of tasks) list.append(el('div', { class: 'http-hist-item', 'data-task': t.id, onclick: () => done(t) }, el('span', { class: 'http-hu', text: t.label }), el('span', { class: 'db-note', text: `${t.source} — ${t.command}` })));
      const cancel = el('button', { class: 'tbtn', text: 'Cancel', onclick: () => done(null) });
      card.append(list, el('div', { class: 'lsp-status-actions' }, cancel)); overlay.append(card);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
      overlay.addEventListener('keydown', (e: any) => { if (e.key === 'Escape') done(null); });
      document.body.append(overlay);
    });
  }

  // ---------- workspace view ----------
  function buildView() {
    const ws = el('div', { id: 'workspace-problems', class: 'workspace' });
    $('#workspace-settings').after(ws);
    FULL_WORKSPACES['problems'] = 'workspace-problems';
    const btn = el('button', { class: 'rail-btn', id: 'rail-problems', 'data-view': 'problems', title: 'Tasks & Problems' });
    btn.innerHTML = '<span class="rail-icon"><svg class="rail-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg></span><span class="rail-label">Problems</span>';
    btn.addEventListener('click', () => { switchRailView('problems'); renderProblems(); });
    $('#rail-settings').before(btn);

    const filter = el('select', { id: 'problems-filter' }, el('option', { value: 'all', text: 'All' }), el('option', { value: 'error', text: 'Errors' }), el('option', { value: 'warning', text: 'Warnings' }));
    filter.addEventListener('change', renderProblems);
    const runBtn = el('button', { class: 'tbtn primary', id: 'tasks-run', text: '▶ Run Task…', onclick: async () => { const t = await pickTask(); if (t) runTask(t); } });
    const rerun = el('button', { class: 'tbtn', id: 'tasks-rerun', text: '↻ Re-run', onclick: () => { if (ts.lastTask) runTask(ts.lastTask); } });
    const stop = el('button', { class: 'tbtn', id: 'tasks-stop', text: '■ Stop', onclick: stopTask });
    const clear = el('button', { class: 'tbtn', text: 'Clear', onclick: () => { ts.output = ''; ts.taskProblems = []; appendOutput(''); renderProblems(); } });
    const bar = el('div', { class: 'http-bar' }, runBtn, rerun, stop, clear, filter);
    const side = el('div', { id: 'problems-list', class: 'http-side' });
    const out = el('pre', { id: 'tasks-output' });
    ws.append(el('div', { class: 'tool-page' }, el('h2', { text: 'Tasks & Problems' }), bar, el('div', { class: 'http-layout' }, side, out)));
    ts.view = ws;
    updateButtons(); renderProblems();
  }

  buildView();
  PALETTE_COMMANDS.push(
    { label: 'Tasks: Run Task…', run: async () => { const t = await pickTask(); if (t) runTask(t); } },
    { label: 'Tasks: Re-run Last Task', run: () => { if (ts.lastTask) runTask(ts.lastTask); else flashToast('No task has been run yet.'); } },
    { label: 'Tasks: Stop Running Task', run: stopTask },
    { label: 'Problems: Show Panel', run: () => { switchRailView('problems'); renderProblems(); } },
  );
  (async () => {
    for (let i = 0; i < 600 && !(window.monaco && typeof editor !== 'undefined' && editor); i++) await sleep(100);
    if (window.monaco) { monaco.editor.onDidChangeMarkers(() => { clearTimeout(ts.t); ts.t = setTimeout(renderProblems, 150); }); renderProblems(); }
  })();
  window.nexoTasks = { load: loadTasks, run: runTask, problems: allProblems, state: ts };
})();
