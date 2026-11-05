


// Real interactive terminals (xterm.js + node-pty) with split panes.
// Upgrades the legacy line-runner terminal in renderer.js in place: if the PTY
// backend can't load, nothing here activates and the old terminal keeps working.
'use strict';
(async function () {
  if (typeof Terminal === 'undefined' || !window.FitAddon) return;
  const avail = await window.nexo.ptyAvailable();
  if (!avail.available) { console.warn('PTY unavailable:', avail.error); return; }

  const panes = new Map(); // ptyId -> pane
  const cssVar = (n: any) => getComputedStyle(document.body).getPropertyValue(n).trim();
  const xtermTheme = () => ({
    background: cssVar('--bg-1') || '#131316', foreground: cssVar('--text') || '#ececf0',
    cursor: cssVar('--accent-a') || '#ff3b30', selectionBackground: 'rgba(255,255,255,.22)',
  });
  const fontFamily = () => cssVar('--code-font') || 'monospace';

  function newPane(session: any) {
    const host = document.createElement('div');
    host.className = 'pty-pane';
    const term = new Terminal({
      fontFamily: fontFamily(), fontSize: 13, cursorBlink: true, scrollback: 5000,
      theme: xtermTheme(), allowProposedApi: true,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    const pane: any = { host, term, fit, id: null, alive: true, session };
    host.addEventListener('mousedown', () => { session.focused = pane; host.parentElement && host.parentElement.querySelectorAll('.pty-pane').forEach((h) => h.classList.toggle('focused', h === host)); });
    session.outputEl.appendChild(host);
    term.open(host);
    // Ctrl+C copies when there is a selection (otherwise it's SIGINT); Ctrl+V pastes via xterm.
    term.attachCustomKeyEventHandler((e: any) => {
      if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); return false; }
      if (e.type === 'keydown' && e.ctrlKey && e.key === '`') return false; // let the app toggle the terminal
      return true;
    });
    const dims = () => { try { fit.fit(); } catch { /* hidden */ } return { cols: term.cols || 80, rows: term.rows || 24 }; };
    term.onData((d: any) => { if (pane.id) window.nexo.ptyWrite(pane.id, d); else (pane.pendingWrites = pane.pendingWrites || []).push(d); });
    term.onResize(({ cols: c, rows: r }: any) => { if (pane.id) window.nexo.ptyResize(pane.id, c, r); });
    requestAnimationFrame(async () => {
      const { cols, rows } = dims();
      const res = await window.nexo.ptySpawn({ cwd: state.projectRoot || undefined, cols, rows, remote: session.remote || undefined });
      if (!res.ok) { term.write(`\r\n\x1b[31m[terminal error] ${res.error}\x1b[0m\r\n`); pane.alive = false; return; }
      pane.id = res.id; panes.set(res.id, pane);
      if (pane.pendingWrites) { pane.pendingWrites.forEach((w: any) => window.nexo.ptyWrite(pane.id, w)); pane.pendingWrites = null; }
      renderTerminalTabs();
    });
    new ResizeObserver(() => { if (host.offsetWidth > 0) dims(); }).observe(host);
    session.panes.push(pane);
    session.focused = pane;
    host.classList.add('focused');
    return pane;
  }

  window.nexo.onPtyData((id: any, data: any) => { const p = panes.get(id); if (p) p.term.write(data); });
  window.nexo.onPtyExit((id: any, code: any) => {
    const p = panes.get(id); if (!p) return;
    p.alive = false; panes.delete(id);
    p.term.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
  });

  const origCreate = createTerminalSession;
  const origSwitch = switchTerminalTab;
  const origClose = closeTerminalTab;
  const origAppend = termAppend;
  const origRun = runCommandInTerminal;

  window.createTerminalSession = function (remote?: any) {
    const session: any = origCreate();
    session.kind = 'pty';
    session.remote = remote || null;
    if (remote && remote.label) session.title = remote.label;
    session.panes = [];
    session.outputEl.classList.add('pty-session');
    newPane(session);
    return session;
  };
  window.switchTerminalTab = function (id) {
    origSwitch(id);
    const t = getActiveTerminal();
    const isPty = !!(t && t.kind === 'pty');
    document.getElementById('terminal-panel')!.classList.toggle('pty-mode', isPty);
    if (isPty) setTimeout(() => { t.panes.forEach((p: any) => { try { p.fit.fit(); } catch { /* hidden */ } }); (t.focused || t.panes[0]).term.focus(); }, 30);
  };
  window.closeTerminalTab = function (id) {
    const t = terminals.find((x) => x.id === id);
    if (t && t.kind === 'pty') t.panes.forEach(killPane);
    origClose(id);
  };
  function killPane(p: any) { if (p.id) { window.nexo.ptyKill(p.id); panes.delete(p.id); } p.term.dispose(); }
  window.termAppend = function (session, text, cls) {
    if (session.kind === 'pty') { (session.focused || session.panes[0]).term.write(text.replace(/\n/g, '\r\n')); return; }
    origAppend(session, text, cls);
  };
  // Scripts/commands launched from panels are typed into the focused shell.
  window.runCommandInTerminal = async function (cmd, runningLabel) {
    if (!state.projectRoot) return;
    toggleTerminal(true);
    let t = getActiveTerminal();
    if (!t || t.kind !== 'pty') { t = terminals.find((x) => x.kind === 'pty'); if (!t) { t = createTerminalSession(); } switchTerminalTab(t.id); }
    const pane = t.focused || t.panes[0];
    const line = cmd + '\r';
    if (pane.id) window.nexo.ptyWrite(pane.id, line); else (pane.pendingWrites = pane.pendingWrites || []).push(line);
    pane.term.focus();
  };

  // Clear button: capture so the legacy handler (which wipes innerHTML) never runs for PTY sessions.
  document.getElementById('term-clear')!.addEventListener('click', (e) => {
    const t = getActiveTerminal();
    if (t && t.kind === 'pty') { e.stopImmediatePropagation(); (t.focused || t.panes[0]).term.clear(); }
  }, true);

  function splitActive(vertical: any) {
    let t = getActiveTerminal();
    if (!t || t.kind !== 'pty') return;
    t.outputEl.classList.toggle('split-v', !!vertical);
    const p = newPane(t);
    setTimeout(() => t.panes.forEach((x: any) => { try { x.fit.fit(); } catch { /* hidden */ } }), 50);
    p.term.focus();
  }
  function closeFocusedPane() {
    const t = getActiveTerminal();
    if (!t || t.kind !== 'pty') return;
    if (t.panes.length === 1) { closeTerminalTab(t.id); return; }
    const p = t.focused || t.panes[t.panes.length - 1];
    killPane(p); p.host.remove();
    t.panes = t.panes.filter((x: any) => x !== p); t.focused = t.panes[t.panes.length - 1];
    t.panes.forEach((x: any) => { try { x.fit.fit(); } catch { /* hidden */ } });
    t.focused.term.focus();
  }

  // Header buttons
  const actions = document.querySelector('#terminal-header .term-actions');
  const mk = (id: any, title: any, text: any, fn: any) => { const b = document.createElement('button'); b.className = 'icon-btn'; b.id = id; b.title = title; b.textContent = text; b.addEventListener('click', fn); return b; };
  actions!.prepend(
    mk('term-split-h', 'Split terminal side by side', '⫼ Split', () => splitActive(false)),
    mk('term-split-v', 'Split terminal top/bottom', '⩸', () => splitActive(true)),
    mk('term-close-pane', 'Close focused pane', '✕ Pane', closeFocusedPane),
  );
  PALETTE_COMMANDS.push(
    { label: 'Terminal: New Terminal', run: () => { toggleTerminal(true); const t = createTerminalSession(); switchTerminalTab(t.id); } },
    { label: 'Terminal: Split Side by Side', run: () => { toggleTerminal(true); splitActive(false); } },
    { label: 'Terminal: Split Top/Bottom', run: () => { toggleTerminal(true); splitActive(true); } },
  );

  // Follow theme changes
  new MutationObserver(() => { panes.forEach((p) => { p.term.options.theme = xtermTheme(); }); }).observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'style'] });

  document.body.classList.add('pty-enabled');
  // Replace any session created before this script ran.
  const stale = terminals.filter((t) => !t.kind);
  if (stale.length) { stale.forEach((t) => { t.outputEl.remove(); }); terminals = terminals.filter((t) => t.kind); }
  window.__ptyReady = true;
})();
