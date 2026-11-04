// @ts-nocheck

(function () {
  const MODE_KEY = 'nexo.gitDiffMode';
  const getMode = () => { try { return localStorage.getItem(MODE_KEY) || 'inline'; } catch { return 'inline'; } };
  const setMode = (m: any) => { try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ } };
  const el = (tag: any, props = {}, kids: any = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const c of [].concat(kids)) if (c) n.append(c);
    return n;
  };
  let diffEditor: any = null;
  function disposeDiffEditor() {
    if (!diffEditor) return;
    const m = diffEditor.getModel();
    try { diffEditor.dispose(); } catch { /* gone */ }
    if (m) { try { m.original.dispose(); m.modified.dispose(); } catch { /* gone */ } }
    diffEditor = null;
  }
  function showSideBySide(host: any, original: any, modified: any, relPath: any) {
    disposeDiffEditor();
    host.innerHTML = '';
    const box = el('div', { class: 'sbs-host' });
    host.append(box);
    const lang = langFromName(relPath.split(/[\\/]/).pop());
    diffEditor = monaco.editor.createDiffEditor(box, {
      readOnly: true, renderSideBySide: true, automaticLayout: true, originalEditable: false,
      fontSize: uiState.fontSize, minimap: { enabled: false }, scrollBeyondLastLine: false,
    });
    diffEditor.setModel({ original: monaco.editor.createModel(original, lang), modified: monaco.editor.createModel(modified, lang) });
  }

  function toolbar(title: any, rerender: any) {
    const mode = getMode();
    const seg = (id: any, label: any) => el('button', { class: 'git-subtab' + (mode === id ? ' active' : ''), text: label, onclick: () => { setMode(id); rerender(); } });
    return el('div', { class: 'diff-toolbar' }, [el('span', { class: 'diff-title', text: title }), el('span', { class: 'diff-seg' }, [seg('inline', 'Inline'), seg('side', 'Side by side')])]);
  }

  // ---------- working-tree / staged diff with hunk + line actions ----------
  const baseShowDiff = showDiff;
  showDiff = async function (relPath: any, staged: any) {
    await baseShowDiff(relPath, staged); // sets up the container, status path, selection state
    const host = document.getElementById('diff-container');
    const rerender = () => showDiff(relPath, staged);
    const bar = toolbar(`${relPath} — ${staged ? 'staged' : 'working tree'}`, rerender);
    if (getMode() === 'side') {
      const v = await window.nexo.gitFileVersions(state.projectRoot, relPath, staged);
      if (!v.ok) return;
      host.innerHTML = ''; host.append(bar);
      const body = el('div', { class: 'sbs-wrap' }); host.append(body);
      showSideBySide(body, v.original, v.modified, relPath);
      return;
    }
    disposeDiffEditor();
    const res = await window.nexo.gitHunks(state.projectRoot, relPath, staged);
    if (!res.ok || !res.hunks.length) { host.prepend(bar); return; } // untracked/binary: keep the plain rendering
    const view = el('div', { class: 'diff-view' });
    const selected = new Map(); // hunk index -> Set(line indexes)
    const act = async (mode: any, selection: any) => {
      const r = await window.nexo.gitApplySelection(state.projectRoot, relPath, mode, selection);
      if (!r.ok) { flashToast(r.error || 'Could not apply.'); return; }
      await refreshGitStatus();
      showDiff(relPath, staged);
    };
    const primary = staged ? ['unstage', 'Unstage'] : ['stage', 'Stage'];
    for (const h of res.hunks) {
      const head = el('div', { class: 'diff-line hunk hunk-head' }, [
        el('span', { class: 'hunk-title', text: `@@ -${h.oldStart} +${h.newStart} @@ ${h.section || ''}` }),
        el('span', { class: 'hunk-actions' }, [
          el('button', { class: 'git-section-action', text: `${primary[1]} hunk`, onclick: () => act(primary[0], [{ hunk: h.index }]) }),
          staged ? null : el('button', { class: 'git-section-action danger', text: 'Discard hunk', onclick: () => { if (confirm('Discard this hunk? This cannot be undone.')) act('discard', [{ hunk: h.index }]); } }),
          el('button', { class: 'git-section-action', text: `${primary[1]} selected lines`, onclick: () => { const s = selected.get(h.index); if (s && s.size) act(primary[0], [{ hunk: h.index, lines: [...s] }]); else flashToast('Tick some +/- lines first.'); } }),
        ]),
      ]);
      view.append(head);
      h.lines.forEach((l: any, i: any) => {
        const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '\\' ? 'meta' : 'ctx';
        const row = el('div', { class: `diff-line ${cls}` });
        if (l.t === '+' || l.t === '-') {
          row.append(el('input', { type: 'checkbox', class: 'line-pick', 'aria-label': 'Select line', onchange: (e: any) => {
            const s = selected.get(h.index) || new Set(); if (e.target.checked) s.add(i); else s.delete(i); selected.set(h.index, s);
          } }));
        } else row.append(el('span', { class: 'line-pick-pad' }));
        row.append(el('span', { class: 'diff-text', text: l.t + l.s || ' ' }));
        view.append(row);
      });
    }
    host.innerHTML = ''; host.append(bar, view);
  };

  // ---------- commit view: details + file list, side-by-side per file ----------
  const baseShowCommitDiff = showCommitDiff;
  showCommitDiff = async function (hash: any, short: any, subject: any) {
    await baseShowCommitDiff(hash, short, subject);
    disposeDiffEditor();
    const host = document.getElementById('diff-container');
    const info = await window.nexo.gitCommitFiles(state.projectRoot, hash);
    if (!info.ok) return;
    const plain = host.querySelector('.diff-view');
    const code = el('div', { class: 'commit-code' });
    if (plain) code.append(plain);
    const files = el('div', { class: 'commit-files' }, info.files.map((f: any) => el('div', { class: 'commit-file', title: 'Open side by side', onclick: async () => {
      const v = await window.nexo.gitCommitVersions(state.projectRoot, hash, f.path);
      if (!v.ok) return;
      code.innerHTML = ''; const w = el('div', { class: 'sbs-wrap' }); code.append(w); showSideBySide(w, v.original, v.modified, f.path);
    } }, [el('span', { class: `gbadge ${['M', 'A', 'D', 'R'].includes(f.status) ? f.status : 'Q'}`, text: f.status }), el('span', { text: f.path })])));
    const meta = el('div', { class: 'commit-detail' }, [
      el('div', { class: 'commit-detail-msg', text: info.message }),
      el('div', { class: 'commit-detail-meta', text: `${info.author} <${info.email}> · ${new Date(info.date).toLocaleString()} · ${info.hash.slice(0, 10)}` }),
    ]);
    host.innerHTML = ''; host.append(meta, files, code);
  };

  // ---------- history tab: commit graph ----------
  const COLORS = ['#ff3b30', '#3b82f6', '#3ecf8e', '#f5a524', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];
  const LANE_W = 14, ROW_H = 38;
  function graphSvg(row: any, laneCount: any) {
    const x = (l: any) => LANE_W / 2 + l * LANE_W, mid = ROW_H / 2;
    const c = (i: any) => COLORS[i % COLORS.length];
    let s = '';
    for (const t of row.through) s += `<line x1="${x(t.lane)}" y1="0" x2="${x(t.lane)}" y2="${ROW_H}" stroke="${c(t.color)}" stroke-width="2"/>`;
    for (const i of row.incoming) s += `<path d="M${x(i.lane)} 0 L${x(row.lane)} ${mid}" stroke="${c(i.color)}" stroke-width="2" fill="none"/>`;
    for (const o of row.outgoing) s += `<path d="M${x(row.lane)} ${mid} L${x(o.to)} ${ROW_H}" stroke="${c(o.color)}" stroke-width="2" fill="none"/>`;
    s += `<circle cx="${x(row.lane)}" cy="${mid}" r="4.5" fill="${c(row.color)}" stroke="var(--bg-1)" stroke-width="1.5"/>`;
    return `<svg width="${Math.max(1, laneCount) * LANE_W}" height="${ROW_H}" aria-hidden="true">${s}</svg>`;
  }
  async function renderGraph(body: any, res: any) {
    const lanes = Math.max(1, ...res.rows.map((r: any) => r.laneCount));
    body.innerHTML = '';
    res.commits.forEach((c: any, i: any) => {
      const refs = c.refs.map((r: any) => `<span class="ref-badge${/HEAD/.test(r) ? ' head' : ''}">${escapeHtml(r.replace('HEAD -> ', ''))}</span>`).join('');
      const row = el('div', { class: 'commit-row graph-row' + (gitState.activeCommit === c.hash ? ' active' : ''), title: c.hash });
      row.innerHTML = `<div class="graph-cell">${graphSvg(res.rows[i], lanes)}</div>
        <div class="graph-text"><div class="commit-subject">${refs}${escapeHtml(c.subject)}</div>
        <div class="commit-meta"><span class="hash">${escapeHtml(c.short)}</span>${escapeHtml(c.author)} · ${escapeHtml(c.date)}</div></div>`;
      row.addEventListener('click', () => showCommitDiff(c.hash, c.short, c.subject));
      body.append(row);
    });
  }
  const baseRenderGitHistory = renderGitHistory;
  renderGitHistory = async function () {
    if (gitState.fileHistoryPath) return renderFileHistory(gitState.fileHistoryPath);
    await baseRenderGitHistory();
    if (!gitState.available) return;
    const res = await window.nexo.gitGraph(state.projectRoot, 200);
    if (res.ok && gitState.subtab === 'history' && !gitState.fileHistoryPath) renderGraph(document.getElementById('git-body'), res);
  };
  async function renderFileHistory(rel: any) {
    gitState.subtab = 'history';
    document.getElementById('git-tab-history').classList.add('active');
    document.getElementById('git-tab-changes').classList.remove('active');
    const body = document.getElementById('git-body');
    const res = await window.nexo.gitFileHistory(state.projectRoot, rel);
    body.innerHTML = '';
    body.append(el('div', { class: 'git-section-title' }, [el('span', { text: 'HISTORY: ' + rel }), el('button', { class: 'git-section-action', text: 'All commits', onclick: () => { gitState.fileHistoryPath = null; renderGitHistory(); } })]));
    if (!res.ok || !res.commits.length) { body.append(el('div', { class: 'git-empty', text: res.error || 'No history for this file.' })); return; }
    for (const c of res.commits) {
      const row = el('div', { class: 'commit-row' });
      row.innerHTML = `<div class="commit-subject">${escapeHtml(c.subject)}</div><div class="commit-meta"><span class="hash">${escapeHtml(c.short)}</span>${escapeHtml(c.author)} · ${escapeHtml(c.date)}</div>`;
      row.addEventListener('click', () => showCommitDiff(c.hash, c.short, c.subject));
      body.append(row);
    }
  }
  window.nexoGitFileHistory = (rel: any) => { gitState.fileHistoryPath = rel; switchRailView('git'); renderGitHistory(); };

  // ---------- changes tab: stash section ----------
  const baseRenderGitPanel = renderGitPanel;
  renderGitPanel = function () {
    gitState.fileHistoryPath = null;
    baseRenderGitPanel();
    if (gitState.available) appendStashSection();
  };
  async function appendStashSection() {
    const body = document.getElementById('git-body');
    const sec = el('div', { id: 'git-stash-section' });
    const head = el('div', { class: 'git-section-title' }, [el('span', { text: 'STASHES' }), el('button', { class: 'git-section-action', text: 'Stash changes…', onclick: stashDialog })]);
    sec.append(head);
    body.insertBefore(sec, document.getElementById('git-commit-box'));
    const res = await window.nexo.gitStashList(state.projectRoot);
    if (!res.ok || !res.stashes.length) { sec.append(el('div', { class: 'git-empty small', text: 'No stashes.' })); return; }
    for (const s of res.stashes) {
      const run = async (fn: any, okMsg: any) => { const r = await fn(state.projectRoot, s.index); if (!r.ok) { alert(r.error || 'Failed.'); } else flashToast(okMsg); refreshGitStatus(); };
      sec.append(el('div', { class: 'stash-row' }, [
        el('div', { class: 'stash-main' }, [el('div', { class: 'stash-subject', text: s.subject }), el('div', { class: 'commit-meta', text: `${s.ref} · ${s.date}` })]),
        el('span', { class: 'hunk-actions' }, [
          el('button', { class: 'git-section-action', text: 'View', onclick: async () => { const r = await window.nexo.gitStashShow(state.projectRoot, s.index); const host = document.getElementById('diff-container'); document.getElementById('editor-container').style.display = 'none'; document.getElementById('welcome').style.display = 'none'; host.style.display = 'block'; host.innerHTML = `<div class="diff-view">${parseDiffToHtml(r.ok ? r.diff : r.error)}</div>`; } }),
          el('button', { class: 'git-section-action', text: 'Apply', onclick: () => run(window.nexo.gitStashApply, 'Stash applied') }),
          el('button', { class: 'git-section-action', text: 'Pop', onclick: () => run(window.nexo.gitStashPop, 'Stash popped') }),
          el('button', { class: 'git-section-action danger', text: 'Drop', onclick: () => { if (confirm('Drop this stash permanently?')) run(window.nexo.gitStashDrop, 'Stash dropped'); } }),
        ]),
      ]));
    }
  }
  function stashDialog() {
    showModal({
      title: 'Stash changes', confirmLabel: 'Stash',
      fields: [{ id: 'msg', label: 'Message (optional)', placeholder: 'WIP: …' }, { id: 'untracked', label: 'Include untracked files? (type y)', placeholder: 'n', initial: '' }],
      onConfirm: async (v: any) => {
        const r = await window.nexo.gitStashPush(state.projectRoot, v.msg, /^y/i.test(v.untracked || ''));
        if (!r.ok) return r.error || 'Stash failed.';
        flashToast(r.nothing ? 'No local changes to stash.' : 'Changes stashed.');
        refreshGitStatus();
      },
    });
  }

  PALETTE_COMMANDS.push(
    { label: 'Git: Stash Changes…', run: stashDialog },
    { label: 'Git: Toggle Side-by-Side Diff', run: () => { setMode(getMode() === 'side' ? 'inline' : 'side'); if (gitState.activePath) showDiff(gitState.activePath, gitState.activeStaged); } },
    { label: 'Git: File History (current file)', run: () => { if (state.activeTab && state.projectRoot) nexoGitFileHistory(relToGitRoot(state.activeTab)); } },
  );
  // The tab buttons captured the original functions; swap them for fresh nodes bound to the wrapped ones.
  for (const [id, fn] of [['git-tab-changes', () => renderGitPanel()], ['git-tab-history', () => renderGitHistory()]]) {
    const b = document.getElementById(id); const nb = b.cloneNode(true); b.replaceWith(nb); nb.addEventListener('click', fn);
  }
  const hd = hideDiff;
  hideDiff = function () { disposeDiffEditor(); return hd(); };
})();
