// Palette commands: export / import custom theme presets as a JSON file.
(function () {
  const T = (window as any).NexoThemePresets;

  async function exportPresets() {
    if (!uiState.customThemes.length) { flashToast('No saved presets to export'); return; }
    const file = await window.nexo.saveAsDialog('nexo-theme-presets.json');
    if (!file) return;
    const res = await window.nexo.writeFile(file, T.serialize(uiState.customThemes));
    flashToast(res && res.ok ? `Exported ${uiState.customThemes.length} preset(s)` : 'Export failed');
  }

  function importPresets() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      try {
        const added = T.parse(await f.text());
        uiState.customThemes = [...uiState.customThemes, ...added].slice(0, 100);
        window.nexo.setPrefs({ customThemes: uiState.customThemes });
        if (document.getElementById('preset-list')) renderSettingsPage(); // re-render so the new chips are wired
        flashToast(`Imported ${added.length} preset(s)`);
      } catch (e: any) { flashToast(e.message || 'Import failed'); }
    });
    input.click();
  }

  PALETTE_COMMANDS.push(
    { label: 'Theme: Export Presets…', run: exportPresets },
    { label: 'Theme: Import Presets…', run: importPresets },
  );
  (window as any).nexoThemePresets = { exportPresets, importPresets };
})();
