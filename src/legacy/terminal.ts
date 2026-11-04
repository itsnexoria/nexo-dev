
// ---------------- Terminal / command runner ----------------
(function setupTerminalResizer() {
  const resizer = document.getElementById('terminal-resizer');
  const panel = document.getElementById('terminal-panel');
  let dragging = false;
  resizer!.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'row-resize'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const h = Math.max(100, Math.min(window.innerHeight * 0.7, window.innerHeight - e.clientY - 24));
    panel!.style.height = h + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; if (editor) editor.layout(); });
})();

// ---------------- Multiple terminal sessions ----------------
let terminals: any[] = [];
let activeTerminalId: any = null;
let nextTerminalNum = 1;

function createTerminalSession() {
  const id = 'term-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const outputEl = document.createElement('div');
  outputEl.className = 'term-session-output';
  document.getElementById('terminal-output')!.appendChild(outputEl);
  const session: any = {
    id,
    title: `Terminal ${nextTerminalNum++}`,
    activeRunId: null,
    runningScript: null,
    history: [],
    historyIdx: -1,
    ansiBuffer: '',
    ansiState: { fg: null, bg: null, bold: false, italic: false, underline: false },
    outputEl,
  };
  terminals.push(session);
  return session;
}

function getActiveTerminal() {
  return terminals.find((t) => t.id === activeTerminalId) || null;
}

function findTerminalByRunId(id: any) {
  return terminals.find((t) => t.activeRunId === id) || null;
}

function switchTerminalTab(id: any) {
  activeTerminalId = id;
  terminals.forEach((t) => t.outputEl.classList.toggle('active', t.id === id));
  renderTerminalTabs();
  const t = getActiveTerminal();
  document.getElementById('term-run-btn')!.textContent = t && t.activeRunId ? 'Stop' : 'Run';
  document.getElementById('terminal-input')!.focus();
}

function closeTerminalTab(id: any) {
  const t = terminals.find((x) => x.id === id);
  if (!t) return;
  if (t.activeRunId) window.nexo.killCommand(t.activeRunId);
  t.outputEl.remove();
  terminals = terminals.filter((x) => x.id !== id);
  if (activeTerminalId === id) {
    const next = terminals[terminals.length - 1];
    if (next) switchTerminalTab(next.id);
    else { activeTerminalId = null; ensureTerminalSession(); }
  } else {
    renderTerminalTabs();
  }
}

function ensureTerminalSession() {
  if (!terminals.length) {
    const t = createTerminalSession();
    switchTerminalTab(t.id);
  } else if (!activeTerminalId) {
    switchTerminalTab(terminals[0].id);
  }
}

function renderTerminalTabs() {
  const bar = document.getElementById('terminal-tabs');
  bar!.innerHTML = '';
  terminals.forEach((t) => {
    const el = document.createElement('div');
    el.className = 'term-tab' + (t.id === activeTerminalId ? ' active' : '') + (t.activeRunId ? ' running' : '');
    el.innerHTML = `<span class="term-tab-dot"></span><span class="term-tab-name">${escapeHtml(t.title)}</span><span class="term-tab-close" title="Close">✕</span>`;
    el.addEventListener('click', (e) => {
      if (e.target!.classList.contains('term-tab-close')) { closeTerminalTab(t.id); return; }
      switchTerminalTab(t.id);
    });
    bar!.appendChild(el);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'term-tab-add';
  addBtn.title = 'New Terminal';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', () => { const t = createTerminalSession(); switchTerminalTab(t.id); });
  bar!.appendChild(addBtn);
}

function termAppend(session: any, text: any, cls: any) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  session.outputEl.appendChild(span);
  session.outputEl.scrollTop = session.outputEl.scrollHeight;
}

// ---------------- ANSI color rendering ----------------
const ANSI_PALETTE: Record<number, string> = {
  30: '#1c1c22', 31: '#f0526b', 32: '#3ecf8e', 33: '#e6b83c', 34: '#3b82f6', 35: '#c084fc', 36: '#22d3ee', 37: '#d4d4d8',
  90: '#6e6e78', 91: '#ff7a90', 92: '#6ee7a8', 93: '#f2cc6b', 94: '#60a5fa', 95: '#d8b4fe', 96: '#67e8f9', 97: '#f5f5f7',
};
function ansi256ToHex(n: any) {
  if (n < 16) {
    const base: any = [
      '#1c1c22', '#f0526b', '#3ecf8e', '#e6b83c', '#3b82f6', '#c084fc', '#22d3ee', '#d4d4d8',
      '#6e6e78', '#ff7a90', '#6ee7a8', '#f2cc6b', '#60a5fa', '#d8b4fe', '#67e8f9', '#f5f5f7',
    ];
    return base[n];
  }
  if (n <= 231) {
    const i = n - 16;
    const level = (v: any) => (v === 0 ? 0 : 55 + v * 40);
    return rgbToHex({ r: level(Math.floor(i / 36)), g: level(Math.floor((i % 36) / 6)), b: level(i % 6) });
  }
  const gray = 8 + (n - 232) * 10;
  return rgbToHex({ r: gray, g: gray, b: gray });
}

function resetAnsiState(session: any) {
  session.ansiBuffer = '';
  session.ansiState = { fg: null, bg: null, bold: false, italic: false, underline: false };
}

function applySgrCodes(session: any, codes: any) {
  const s = session.ansiState;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) { session.ansiState = { fg: null, bg: null, bold: false, italic: false, underline: false }; }
    else if (code === 1) s.bold = true;
    else if (code === 3) s.italic = true;
    else if (code === 4) s.underline = true;
    else if (code === 22) s.bold = false;
    else if (code === 23) s.italic = false;
    else if (code === 24) s.underline = false;
    else if (code === 39) s.fg = null;
    else if (code === 49) s.bg = null;
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) s.fg = ANSI_PALETTE[code];
    else if (code >= 40 && code <= 47) s.bg = ANSI_PALETTE[code - 10];
    else if (code >= 100 && code <= 107) s.bg = ANSI_PALETTE[code - 10];
    else if (code === 38 || code === 48) {
      const target = code === 38 ? 'fg' : 'bg';
      const mode = codes[i + 1];
      if (mode === 5) { s[target] = ansi256ToHex(codes[i + 2]); i += 2; }
      else if (mode === 2) { s[target] = rgbToHex({ r: codes[i + 2], g: codes[i + 3], b: codes[i + 4] }); i += 4; }
    }
  }
}

function appendAnsiText(session: any, frag: any, str: any) {
  if (!str) return;
  const s = session.ansiState;
  const span = document.createElement('span');
  const styleParts = [];
  if (s.fg) styleParts.push(`color:${s.fg}`);
  if (s.bg) styleParts.push(`background-color:${s.bg}`);
  if (s.bold) styleParts.push('font-weight:700');
  if (s.italic) styleParts.push('font-style:italic');
  if (s.underline) styleParts.push('text-decoration:underline');
  if (styleParts.length) span.setAttribute('style', styleParts.join(';'));
  span.textContent = str;
  frag.appendChild(span);
}

// Process output be terminal-style ANSI (colors, bold, etc.) instead of the
// raw escape codes. Process output can split a sequence — or a line —
// across multiple data chunks, so an incomplete trailing escape sequence is
// held back and prepended to the next chunk rather than dropped/garbled.
function termAppendAnsi(session: any, chunk: any) {
  let text = session.ansiBuffer + chunk;
  session.ansiBuffer = '';
  const incomplete = text.match(/\x1b\[[0-9;]*$/);
  if (incomplete) {
    session.ansiBuffer = incomplete[0];
    text = text.slice(0, -session.ansiBuffer.length);
  }

  const frag = document.createDocumentFragment();
  const re = /\x1b\[([0-9;]*)([a-zA-Z])/g;
  let lastIndex = 0;
  let match;
  while ((match = re.exec(text))) {
    if (match.index > lastIndex) appendAnsiText(session, frag, text.slice(lastIndex, match.index));
    if (match[2] === 'm') {
      const codes = match[1].length ? match[1].split(';').map((c) => (c === '' ? 0 : parseInt(c, 10))) : [0];
      applySgrCodes(session, codes);
    }
    // Non-color codes (cursor movement, clear line, etc.) are silently dropped —
    // there's no real terminal cursor here, just an append-only log.
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) appendAnsiText(session, frag, text.slice(lastIndex));
  session.outputEl.appendChild(frag);
  session.outputEl.scrollTop = session.outputEl.scrollHeight;
}

function toggleTerminal(forceShow?: any) {
  const panel = document.getElementById('terminal-panel');
  const show = forceShow !== undefined ? forceShow : !panel!.classList.contains('active');
  panel!.classList.toggle('active', show);
  document.getElementById('terminal-cwd')!.textContent = state.projectRoot ? `— ${state.projectRoot}` : '';
  if (show) {
    ensureTerminalSession();
    document.getElementById('terminal-input')!.focus();
  }
  if (editor) editor.layout();
}

function toggleZenMode(forceOn?: any) {
  const on = forceOn !== undefined ? forceOn : !document.body.classList.contains('zen-mode');
  document.body.classList.toggle('zen-mode', on);
  if (on) toggleTerminal(false); // start distraction-free with the terminal closed too
  if (editor) editor.layout();
  if (splitEditor) splitEditor.layout();
}

async function runTerminalCommand() {
  const input = document.getElementById('terminal-input');
  const cmd = input!.value.trim();
  const t = getActiveTerminal();
  if (!t) return;
  if (!cmd && !t.activeRunId) return;
  if (!state.projectRoot) { termAppend(t, 'Open a folder first — commands run in the project root.\n', 'term-err'); return; }
  if (t.activeRunId) { // a program is running: send the line to its stdin (input(), REPLs, pdb…)
    termAppend(t, cmd + '\n', 'term-cmd');
    input!.value = '';
    if (t.activeRunId === 'dbg') await dbgApi().write(cmd + '\n');
    else await window.nexo.writeCommand(t.activeRunId, cmd + '\n');
    return;
  }

  t.history.push(cmd);
  t.historyIdx = t.history.length;
  resetAnsiState(t);
  termAppend(t, `\n$ ${cmd}\n`, 'term-cmd');
  input!.value = '';

  const res = await window.nexo.runCommand(state.projectRoot, cmd);
  if (!res.id) {
    termAppend(t, `[error] ${res.error || 'Could not start command.'}\n`, 'term-err');
    return;
  }
  t.activeRunId = res.id;
  if (t.id === activeTerminalId) document.getElementById('term-run-btn')!.textContent = 'Stop';
  renderTerminalTabs();
}

async function stopTerminalCommand() {
  const t = getActiveTerminal();
  if (!t || !t.activeRunId) return;
  if (t.activeRunId === 'dbg') { await dbgApi().stop(); return; }
  await window.nexo.killCommand(t.activeRunId);
}

window.nexo.onTermData((id: any, chunk: any) => {
  const t = findTerminalByRunId(id);
  if (!t) return;
  termAppendAnsi(t, chunk);
});
window.nexo.onTermExit((id: any, code: any) => {
  const t = findTerminalByRunId(id);
  if (!t) return;
  termAppend(t, `[exited with code ${code}]\n`, 'term-exit');
  t.activeRunId = null;
  t.runningScript = null;
  if (t.id === activeTerminalId) document.getElementById('term-run-btn')!.textContent = 'Run';
  renderTerminalTabs();
  renderScriptsPanel();
});

document.getElementById('term-run-btn')!.addEventListener('click', () => {
  const t = getActiveTerminal();
  if (t && t.activeRunId) stopTerminalCommand();
  else runTerminalCommand();
});
document.getElementById('terminal-input')!.addEventListener('keydown', (e) => {
  const t = getActiveTerminal();
  if (!t) return;
  if (e.key === 'Enter') { e.preventDefault(); runTerminalCommand(); return; }
  if (e.key === 'ArrowUp') {
    if (t.historyIdx > 0) { t.historyIdx--; e.target!.value = t.history[t.historyIdx]; }
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowDown') {
    if (t.historyIdx < t.history.length - 1) {
      t.historyIdx++;
      e.target!.value = t.history[t.historyIdx];
    } else {
      t.historyIdx = t.history.length;
      e.target!.value = '';
    }
    e.preventDefault();
  }
});
document.getElementById('term-clear')!.addEventListener('click', () => {
  const t = getActiveTerminal();
  if (!t) return;
  t.outputEl.innerHTML = '';
  resetAnsiState(t);
});
document.getElementById('term-close')!.addEventListener('click', () => toggleTerminal(false));
document.getElementById('btn-toggle-terminal')!.addEventListener('click', () => toggleTerminal());
