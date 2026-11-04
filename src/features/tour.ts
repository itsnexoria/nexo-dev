
// First-run tour: a small non-blocking card, shown once (remembered in localStorage), re-runnable from the palette.
(function () {
  const KEY = 'nexo.tourDone';
  const STEPS = [
    { t: 'Welcome to Nexo Dev', b: 'A quick tour of the essentials (30 seconds).' },
    { t: 'Command Palette', b: 'Press Ctrl+Shift+P to run any command, or Ctrl+P to jump to a file.' },
    { t: 'Activity bar', b: 'Files, search, source control, debugging, HTTP client and databases live on the left rail.' },
    { t: 'Terminal', b: 'Ctrl+` toggles the integrated terminal; Ctrl+\\ splits the editor.' },
    { t: 'Make it yours', b: 'Rebind keys via "Preferences: Keyboard Shortcuts" and add themes or snippets with "Extensions: Manage".' },
  ];
  const get = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
  const set = () => { try { localStorage.setItem(KEY, '1'); } catch { /* storage unavailable */ } };
  function show() {
    if (document.getElementById('tour-card')) return;
    let i = 0;
    const card = document.createElement('div'); card.id = 'tour-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Welcome tour');
    const title = document.createElement('b'); const body = document.createElement('p'); const row = document.createElement('div'); row.className = 'tour-row';
    const skip = document.createElement('button'); skip.className = 'tbtn'; skip.id = 'tour-skip'; skip.textContent = 'Skip';
    const next = document.createElement('button'); next.className = 'tbtn'; next.id = 'tour-next';
    const done = () => { set(); card.remove(); };
    const render = () => { title.textContent = STEPS[i].t; body.textContent = STEPS[i].b; next.textContent = i === STEPS.length - 1 ? 'Done' : `Next (${i + 1}/${STEPS.length})`; };
    skip.addEventListener('click', done); next.addEventListener('click', () => { if (i === STEPS.length - 1) done(); else { i++; render(); } });
    row.append(skip, next); card.append(title, body, row); document.body.append(card); render();
  }
  PALETTE_COMMANDS.push({ label: 'Help: Show Welcome Tour', run: show });
  window.nexoTour = { show };
  setTimeout(() => { if (!get()) show(); }, 1500);
})();
