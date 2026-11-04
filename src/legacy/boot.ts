
// ---------------- Boot ----------------
// Monaco is a couple MB across many files (asar is disabled for it), so it's
// the slowest thing to load. Load it in the background instead of blocking
// the welcome screen / recent projects / sites list from appearing.
async function boot() {
  // Load saved settings before Monaco initializes so the editor is created
  // with the right theme/font/minimap/wrap from the start instead of
  // flashing or re-applying options after the fact.
  try {
    const prefs = await window.nexo.getPrefs();
    Object.assign(uiState, prefs);
    applyTheme(uiState.theme, { skipSave: true });
    updateDiscordPresence();
  } catch { /* keep defaults */ }

  monacoReadyPromise = new Promise<void>((resolve) => {
    initMonaco(() => { monacoLoaded = true; resolve(); });
  });

  refreshRecent();
  renderSettingsPage();

  // Tell the main process the UI has actually painted, so it can swap the
  // splash screen for the real window instead of guessing at a timeout.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (window.nexo && window.nexo.notifyReady) window.nexo.notifyReady();
    });
  });
}
boot();

document.getElementById('btn-run-py')?.addEventListener('click', () => runPythonFile());
