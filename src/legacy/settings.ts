
// ---------------- Workspace / panel switching (activity rail) ----------------
const FULL_WORKSPACES: Record<string, string> = { settings: 'workspace-settings' };

function switchRailView(view: any) {
  document.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

  if (FULL_WORKSPACES[view]) {
    document.getElementById('workspace-explorer')!.classList.remove('active');
    for (const [id, elId] of Object.entries(FULL_WORKSPACES)) {
      document.getElementById(elId)!.classList.toggle('active', id === view);
    }
    if (view === 'settings') renderSettingsPage();
    return;
  }

  document.getElementById('workspace-explorer')!.classList.add('active');
  for (const elId of Object.values(FULL_WORKSPACES)) document.getElementById(elId)!.classList.remove('active');
  document.querySelectorAll('.sidebar-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${view}`));

  if (editor) editor.layout();
  if (view === 'search') document.getElementById('search-input')!.focus();
  if (view === 'git') refreshGitStatus();
  if (view === 'scripts') loadScripts();
  if (view === 'python') loadPython();
  if (view === 'debug') renderDebugPanel();
  if (view === 'outline') renderOutlinePanel();
  if (view === 'github') loadGithubPanel();
  if (view === 'todos') loadTodos();
}

document.querySelectorAll('.rail-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchRailView(btn.dataset.view));
});

// ---------------- Settings page ----------------
function applyEditorOptionToBoth(opts: any) {
  if (editor) editor.updateOptions(opts);
  if (splitEditor) splitEditor.updateOptions(opts);
}

function setFontSize(newSize: any) {
  const clamped = Math.max(9, Math.min(28, newSize));
  uiState.fontSize = clamped;
  applyEditorOptionToBoth({ fontSize: clamped });
  window.nexo.setPrefs({ fontSize: clamped });
  const fontInput = document.getElementById('set-font-size');
  if (fontInput) fontInput.value = clamped;
}
function changeFontSize(delta: any) { setFontSize(Math.round((uiState.fontSize + delta) * 2) / 2); }
function resetFontSize() { setFontSize(13.5); }

function renderPresetChips() {
  if (!uiState.customThemes.length) {
    return '<span class="trend-empty">No saved presets yet.</span>';
  }
  return uiState.customThemes.map((p: any) => `
    <div class="settings-theme-card preset-chip" data-preset-id="${p.id}" title="${escapeHtml(p.name)}">
      <span class="swatch" style="background:${p.accent}"></span><span>${escapeHtml(p.name)}</span>
      <span class="preset-remove" data-preset-id="${p.id}" title="Delete preset">✕</span>
    </div>
  `).join('');
}

function renderSettingsPage() {
  const page = document.getElementById('settings-page');
  const themeCards = [...THEMES, { ...CUSTOM_THEME_META, swatch: uiState.customTheme.accent }].map((t) => `
    <div class="settings-theme-card ${t.id === uiState.theme ? 'current' : ''}" data-theme-id="${t.id}">
      <span class="swatch" style="background:${t.swatch}"></span><span>${t.label}</span>
    </div>
  `).join('');

  page!.innerHTML = `
    <h1 class="settings-title">Settings</h1>
    <p class="settings-subtitle">Changes apply immediately and are remembered across restarts.</p>

    <div class="settings-section">
      <h2>Appearance</h2>
      <div class="settings-row">
        <div><div class="settings-row-label">Theme</div></div>
        <div class="settings-control"><div class="settings-theme-grid">${themeCards}</div></div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Custom theme colors</div>
          <div class="settings-row-desc">Pick a background, text, and accent color — everything else (panels, borders, diff highlights, etc.) is generated automatically to match. Changing any of these switches to the Custom theme.</div>
        </div>
        <div class="settings-control">
          <input type="color" class="settings-color" id="set-custom-bg" value="${uiState.customTheme.bg}" title="Background" />
          <input type="color" class="settings-color" id="set-custom-text" value="${uiState.customTheme.text}" title="Text" />
          <input type="color" class="settings-color" id="set-custom-accent" value="${uiState.customTheme.accent}" title="Accent" />
          <button class="icon-btn" id="set-save-preset-btn" title="Save these colors as a named preset">＋ Save preset</button>
        </div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Saved presets</div>
          <div class="settings-row-desc">Your saved custom-theme color combinations. Click one to apply it, or the ✕ to delete it.</div>
        </div>
        <div class="settings-control"><div class="settings-theme-grid" id="preset-list">${renderPresetChips()}</div></div>
      </div>
      <div class="settings-row">
        <div><div class="settings-row-label">Font size</div></div>
        <div class="settings-control">
          <input type="number" class="settings-number" id="set-font-size" min="9" max="28" step="0.5" value="${uiState.fontSize}" />
        </div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Minimap</div>
          <div class="settings-row-desc">The small code overview on the right edge of the editor. Auto-disabled on large files regardless of this setting.</div>
        </div>
        <div class="settings-control"><div class="settings-toggle ${uiState.minimap ? 'on' : ''}" id="set-minimap"></div></div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Word wrap</div>
          <div class="settings-row-desc">Wrap long lines instead of scrolling horizontally.</div>
        </div>
        <div class="settings-control"><div class="settings-toggle ${uiState.wordWrap ? 'on' : ''}" id="set-word-wrap"></div></div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Bracket pair colorization &amp; indent guides</div>
          <div class="settings-row-desc">Color-matches bracket pairs and shows indent guide lines. Off by default — it's one of the pricier Monaco features on large files.</div>
        </div>
        <div class="settings-control"><div class="settings-toggle ${uiState.bracketGuides ? 'on' : ''}" id="set-bracket-guides"></div></div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Vim keybindings</div>
          <div class="settings-row-desc">Modal editing (Normal/Insert/Visual modes) in the main editor. Loaded on demand the first time you turn it on. Applies to the main editor only, not the split view.</div>
        </div>
        <div class="settings-control"><div class="settings-toggle ${uiState.vimMode ? 'on' : ''}" id="set-vim-mode"></div></div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Format on save (Prettier)</div>
          <div class="settings-row-desc">Runs the project's own local Prettier install before every save. Silently does nothing on projects without Prettier installed, or files it can't parse.</div>
        </div>
        <div class="settings-control"><div class="settings-toggle ${uiState.formatOnSave ? 'on' : ''}" id="set-format-on-save"></div></div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Project settings override</div>
          <div class="settings-row-desc">
            ${state.projectRoot
              ? (state.projectSettingsActive
                ? 'This project has a <code>.nexo/settings.json</code> overriding some settings above, just for this project.'
                : 'This project has no override yet — the settings above are your global defaults.')
              : 'Open a project to set up a per-project override.'}
          </div>
        </div>
        <div class="settings-control">
          <button class="tbtn" id="btn-open-project-settings" ${state.projectRoot ? '' : 'disabled'}>Edit File</button>
          <button class="tbtn" id="btn-save-project-settings" ${state.projectRoot ? '' : 'disabled'}>Save Current</button>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h2>Editor</h2>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Auto Save</div>
          <div class="settings-row-desc">Automatically save the active file a short while after you stop typing.</div>
        </div>
        <div class="settings-control"><div class="settings-toggle ${uiState.autoSave ? 'on' : ''}" id="set-autosave"></div></div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Auto Save delay</div>
          <div class="settings-row-desc">How long to wait after you stop typing before saving.</div>
        </div>
        <div class="settings-control">
          <input type="number" class="settings-number" id="set-autosave-delay" min="200" max="10000" step="100" value="${uiState.autoSaveDelayMs}" /> ms
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h2>Snippets</h2>
      <div class="settings-row-desc" style="margin-bottom:10px;">Text expansions available in the editor's autocomplete. Type the prefix and accept the suggestion to expand it. Use <code>$1</code>, <code>$2</code>, <code>\${1:default}</code> for tab stops and <code>$0</code> for the final cursor position.</div>
      <div id="snippets-list"></div>
      <button class="tbtn" id="snippets-add-btn">+ Add Snippet</button>
      <div id="snippet-form" class="hidden">
        <div class="snippet-form-row">
          <input type="text" class="settings-text" id="snippet-prefix" placeholder="Prefix (e.g. clg)" spellcheck="false" autocomplete="off" />
          <select class="settings-select" id="snippet-language">
            <option value="all">All languages</option>
            <option value="javascript">JavaScript</option>
            <option value="typescript">TypeScript</option>
            <option value="python">Python</option>
            <option value="html">HTML</option>
            <option value="css">CSS</option>
            <option value="json">JSON</option>
            <option value="markdown">Markdown</option>
          </select>
        </div>
        <input type="text" class="settings-text" id="snippet-description" placeholder="Description (optional)" style="width:100%; margin-top:8px;" />
        <textarea id="snippet-body" placeholder="console.log($1);$0" spellcheck="false"></textarea>
        <div class="snippet-form-actions">
          <button class="tbtn" id="snippet-cancel-btn">Cancel</button>
          <button class="tbtn primary" id="snippet-save-btn">Save Snippet</button>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h2>Terminal</h2>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Custom shell</div>
          <div class="settings-row-desc">Optional. Overrides the default shell (Command Prompt on Windows) used by the Terminal panel — e.g. a path to PowerShell or Git Bash. Leave blank to use the system default.</div>
        </div>
        <div class="settings-control"><input type="text" class="settings-text" id="set-custom-shell" placeholder="e.g. powershell.exe" value="${escapeHtml(uiState.customShell || '')}" /></div>
      </div>
    </div>

    <div class="settings-section">
      <h2>Discord Rich Presence</h2>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Show activity in Discord</div>
          <div class="settings-row-desc">Displays what you're working on (current file &amp; project) on your Discord profile while Nexo Dev and Discord are both open. Requires your own free Discord Application Client ID below.</div>
        </div>
        <div class="settings-control"><div class="settings-toggle ${uiState.discordRpcEnabled ? 'on' : ''}" id="set-discord-enabled"></div></div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Client ID</div>
          <div class="settings-row-desc">From a Discord application you create at <a href="#" id="discord-dev-portal-link">discord.com/developers/applications</a> (free, takes under a minute — name it "Nexo Dev" or anything you like). Optionally upload an image named <code>nexo_logo</code> as a Rich Presence asset to have it show up as the large icon.</div>
        </div>
        <div class="settings-control"><input type="text" class="settings-text" id="set-discord-client-id" placeholder="e.g. 1234567890123456789" value="${escapeHtml(uiState.discordClientId || '')}" /></div>
      </div>
    </div>

    <div class="settings-section">
      <h2>GitHub</h2>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Personal Access Token</div>
          <div class="settings-row-desc">Powers push/pull without credential prompts, browsing &amp; cloning your repos, creating new repos, and viewing open PRs &amp; issues for the current project. Stored encrypted via your OS keychain — never leaves this device except to talk to api.github.com. Needs the <code>repo</code> scope. <a href="https://github.com/settings/tokens/new" id="gh-token-help">Create one on GitHub →</a></div>
        </div>
        <div class="settings-control" id="gh-token-control"></div>
      </div>
    </div>

    <div class="settings-section">
      <h2>About</h2>
      <div class="settings-about">
        <img src="icons/logo-96.png" alt="" />
        <div>
          <div class="settings-about-name">Nexo Dev</div>
          <div class="settings-about-meta">A fast, focused editor for your projects — built for the Nexo network.</div>
        </div>
      </div>
    </div>
  `;

  // ---- wire it all up ----
  page!.querySelectorAll('.settings-theme-card').forEach((card) => {
    if (!card.dataset.themeId) return; // preset chips share this class for styling but are wired separately below
    card.addEventListener('click', () => {
      applyTheme(card.dataset.themeId);
      page!.querySelectorAll('.settings-theme-card').forEach((c) => c.classList.toggle('current', c === card));
    });
  });

  document.getElementById('set-save-preset-btn')!.addEventListener('click', () => {
    showModal({
      title: 'Save Theme Preset',
      fields: [{ id: 'name', placeholder: 'e.g. Ocean, Sunset, Work Mode…' }],
      onConfirm: ({ name }: any): any => {
        const preset = { id: `theme_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name, ...uiState.customTheme };
        uiState.customThemes = [...uiState.customThemes, preset];
        window.nexo.setPrefs({ customThemes: uiState.customThemes });
        document.getElementById('preset-list')!.innerHTML = renderPresetChips();
        wirePresetChips();
        return null;
      },
    });
  });

  function wirePresetChips() {
    document.querySelectorAll('.preset-chip').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        if (e.target!.classList.contains('preset-remove')) return;
        const preset = uiState.customThemes.find((p: any) => p.id === chip.dataset.presetId);
        if (!preset) return;
        uiState.customTheme = { bg: preset.bg, text: preset.text, accent: preset.accent };
        applyTheme('custom');
        document.getElementById('set-custom-bg')!.value = preset.bg;
        document.getElementById('set-custom-text')!.value = preset.text;
        document.getElementById('set-custom-accent')!.value = preset.accent;
        page!.querySelectorAll('.settings-theme-card[data-theme-id]').forEach((c) => c.classList.toggle('current', c.dataset.themeId === 'custom'));
      });
    });
    document.querySelectorAll('.preset-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        uiState.customThemes = uiState.customThemes.filter((p: any) => p.id !== btn.dataset.presetId);
        window.nexo.setPrefs({ customThemes: uiState.customThemes });
        document.getElementById('preset-list')!.innerHTML = renderPresetChips();
        wirePresetChips();
      });
    });
  }
  wirePresetChips();

  ['bg', 'text', 'accent'].forEach((key) => {
    const input = document.getElementById(`set-custom-${key}`);
    input!.addEventListener('input', (e) => {
      uiState.customTheme = { ...uiState.customTheme, [key]: e.target!.value };
      applyTheme('custom', { skipSave: true });
      page!.querySelectorAll('.settings-theme-card[data-theme-id]').forEach((c) => c.classList.toggle('current', c.dataset.themeId === 'custom'));
    });
    input!.addEventListener('change', (e) => {
      uiState.customTheme = { ...uiState.customTheme, [key]: e.target!.value };
      applyTheme('custom');
    });
  });

  document.getElementById('set-font-size')!.addEventListener('change', (e) => {
    const val = Math.max(9, Math.min(28, Number(e.target!.value) || 13.5));
    uiState.fontSize = val;
    e.target!.value = val;
    applyEditorOptionToBoth({ fontSize: val });
    window.nexo.setPrefs({ fontSize: val });
  });

  const minimapToggle = document.getElementById('set-minimap');
  minimapToggle!.addEventListener('click', () => {
    uiState.minimap = !uiState.minimap;
    minimapToggle!.classList.toggle('on', uiState.minimap);
    applyEditorOptionToBoth({ minimap: { enabled: uiState.minimap, renderCharacters: false, maxColumn: 80 } });
    window.nexo.setPrefs({ minimap: uiState.minimap });
  });

  const wordWrapToggle = document.getElementById('set-word-wrap');
  wordWrapToggle!.addEventListener('click', () => {
    uiState.wordWrap = !uiState.wordWrap;
    wordWrapToggle!.classList.toggle('on', uiState.wordWrap);
    applyEditorOptionToBoth({ wordWrap: uiState.wordWrap ? 'on' : 'off' });
    window.nexo.setPrefs({ wordWrap: uiState.wordWrap });
  });

  const bracketGuidesToggle = document.getElementById('set-bracket-guides');
  bracketGuidesToggle!.addEventListener('click', () => {
    uiState.bracketGuides = !uiState.bracketGuides;
    bracketGuidesToggle!.classList.toggle('on', uiState.bracketGuides);
    applyEditorOptionToBoth({
      bracketPairColorization: { enabled: uiState.bracketGuides },
      guides: { indentation: uiState.bracketGuides, bracketPairs: uiState.bracketGuides },
    });
    window.nexo.setPrefs({ bracketGuides: uiState.bracketGuides });
  });

  const vimModeToggle = document.getElementById('set-vim-mode');
  vimModeToggle!.addEventListener('click', () => {
    uiState.vimMode = !uiState.vimMode;
    vimModeToggle!.classList.toggle('on', uiState.vimMode);
    if (uiState.vimMode) enableVimMode();
    else disableVimMode();
    window.nexo.setPrefs({ vimMode: uiState.vimMode });
  });

  const formatOnSaveToggle = document.getElementById('set-format-on-save');
  formatOnSaveToggle!.addEventListener('click', () => {
    uiState.formatOnSave = !uiState.formatOnSave;
    formatOnSaveToggle!.classList.toggle('on', uiState.formatOnSave);
    window.nexo.setPrefs({ formatOnSave: uiState.formatOnSave });
  });

  if (state.projectRoot) {
    document.getElementById('btn-open-project-settings')!.addEventListener('click', handleOpenProjectSettings);
    document.getElementById('btn-save-project-settings')!.addEventListener('click', handleSaveCurrentAsProjectSettings);
  }

  const autoSaveToggle = document.getElementById('set-autosave');
  autoSaveToggle!.addEventListener('click', () => {
    uiState.autoSave = !uiState.autoSave;
    autoSaveToggle!.classList.toggle('on', uiState.autoSave);
    window.nexo.setPrefs({ autoSave: uiState.autoSave });
  });

  document.getElementById('set-autosave-delay')!.addEventListener('change', (e) => {
    const val = Math.max(200, Math.min(10000, Number(e.target!.value) || 1000));
    uiState.autoSaveDelayMs = val;
    e.target!.value = val;
    window.nexo.setPrefs({ autoSaveDelayMs: val });
  });

  document.getElementById('set-custom-shell')!.addEventListener('change', (e) => {
    uiState.customShell = e.target!.value.trim();
    window.nexo.setPrefs({ customShell: uiState.customShell });
  });

  const discordEnabledToggle = document.getElementById('set-discord-enabled');
  discordEnabledToggle!.addEventListener('click', () => {
    uiState.discordRpcEnabled = !uiState.discordRpcEnabled;
    discordEnabledToggle!.classList.toggle('on', uiState.discordRpcEnabled);
    window.nexo.setPrefs({ discordRpcEnabled: uiState.discordRpcEnabled });
    if (uiState.discordRpcEnabled) updateDiscordPresence();
  });
  document.getElementById('set-discord-client-id')!.addEventListener('change', (e) => {
    uiState.discordClientId = e.target!.value.trim();
    window.nexo.setPrefs({ discordClientId: uiState.discordClientId });
  });
  document.getElementById('discord-dev-portal-link')!.addEventListener('click', (e) => {
    e.preventDefault();
    window.nexo.openExternal('https://discord.com/developers/applications');
  });

  document.getElementById('gh-token-help')!.addEventListener('click', (e) => {
    e.preventDefault();
    window.nexo.openExternal(e.currentTarget!.href);
  });
  renderGithubSettingsControl();
  renderSnippetsList();
  wireSnippetForm();
}

async function renderGithubSettingsControl() {
  const box = document.getElementById('gh-token-control');
  if (!box) return;
  box.innerHTML = '<span class="settings-row-desc">Checking…</span>';
  const status = await window.nexo.hasGithubToken();
  if (status.hasToken) {
    const res = await window.nexo.getGithubUser();
    if (res.ok) {
      box.innerHTML = `
        <div class="gh-connected">
          <span class="gh-connected-user">✓ Connected as <strong>${escapeHtml(res.user.login)}</strong></span>
          <button class="tbtn danger-tbtn" id="gh-disconnect-btn">Disconnect</button>
        </div>`;
      document.getElementById('gh-disconnect-btn')!.addEventListener('click', async () => {
        await window.nexo.clearGithubToken();
        renderGithubSettingsControl();
      });
      return;
    }
    // Saved token exists but GitHub no longer accepts it (expired/revoked) — fall through to the connect form.
  }
  box.innerHTML = `
    <input type="password" class="settings-text" id="gh-token-input" placeholder="ghp_…" autocomplete="off" spellcheck="false" />
    <button class="tbtn primary" id="gh-connect-btn">Connect</button>
    <div id="gh-token-error" class="hidden"></div>
  `;
  const errBox = document.getElementById('gh-token-error');
  const connectBtn = document.getElementById('gh-connect-btn');
  const doConnect = async () => {
    const input = document.getElementById('gh-token-input');
    const token = input!.value.trim();
    if (!token) return;
    connectBtn!.disabled = true;
    connectBtn!.textContent = 'Connecting…';
    errBox!.classList.add('hidden');
    let res;
    try {
      res = await window.nexo.setGithubToken(token);
    } finally {
      connectBtn!.disabled = false;
      connectBtn!.textContent = 'Connect';
    }
    if (!res.ok) {
      errBox!.textContent = res.error;
      errBox!.classList.remove('hidden');
      return;
    }
    renderGithubSettingsControl();
  };
  connectBtn!.addEventListener('click', doConnect);
  document.getElementById('gh-token-input')!.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doConnect(); }
  });
}

// ---------------- Snippets ----------------
let snippetEditingId: any = null;

function renderSnippetsList() {
  const box = document.getElementById('snippets-list');
  if (!box) return;
  const snippets = uiState.snippets || [];
  if (!snippets.length) {
    box.innerHTML = '<div class="settings-row-desc" style="margin-bottom:10px;">No snippets yet.</div>';
    return;
  }
  box.innerHTML = snippets.map((s: any) => `
    <div class="snippet-row" data-id="${escapeHtml(s.id)}">
      <div class="snippet-row-main">
        <span class="snippet-prefix">${escapeHtml(s.prefix)}</span>
        <span class="snippet-lang">${escapeHtml(s.language === 'all' ? 'all languages' : s.language)}</span>
        ${s.description ? `<span class="snippet-desc">${escapeHtml(s.description)}</span>` : ''}
      </div>
      <div class="snippet-row-actions">
        <button class="icon-btn snippet-edit-btn" title="Edit">✎</button>
        <button class="icon-btn snippet-delete-btn" title="Delete">🗑</button>
      </div>
    </div>`).join('');
  box.querySelectorAll('.snippet-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => openSnippetForm(btn.closest('.snippet-row')!.dataset.id));
  });
  box.querySelectorAll('.snippet-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.snippet-row')!.dataset.id;
      const s = (uiState.snippets || []).find((x: any) => x.id === id);
      if (s && !confirm(`Delete the "${s.prefix}" snippet?`)) return;
      uiState.snippets = (uiState.snippets || []).filter((x: any) => x.id !== id);
      await window.nexo.setPrefs({ snippets: uiState.snippets });
      renderSnippetsList();
    });
  });
}

function openSnippetForm(id: any) {
  const form = document.getElementById('snippet-form');
  form!.classList.remove('hidden');
  if (id) {
    const s = (uiState.snippets || []).find((x: any) => x.id === id);
    if (!s) return;
    snippetEditingId = id;
    document.getElementById('snippet-prefix')!.value = s.prefix;
    document.getElementById('snippet-language')!.value = s.language;
    document.getElementById('snippet-description')!.value = s.description || '';
    document.getElementById('snippet-body')!.value = s.body;
    document.getElementById('snippet-save-btn')!.textContent = 'Update Snippet';
  } else {
    snippetEditingId = null;
    document.getElementById('snippet-prefix')!.value = '';
    document.getElementById('snippet-language')!.value = 'all';
    document.getElementById('snippet-description')!.value = '';
    document.getElementById('snippet-body')!.value = '';
    document.getElementById('snippet-save-btn')!.textContent = 'Save Snippet';
  }
  document.getElementById('snippet-prefix')!.focus();
}

function closeSnippetForm() {
  document.getElementById('snippet-form')!.classList.add('hidden');
  snippetEditingId = null;
}

function wireSnippetForm() {
  document.getElementById('snippets-add-btn')!.addEventListener('click', () => openSnippetForm(null));
  document.getElementById('snippet-cancel-btn')!.addEventListener('click', closeSnippetForm);
  document.getElementById('snippet-save-btn')!.addEventListener('click', async () => {
    const prefix = document.getElementById('snippet-prefix')!.value.trim();
    const language = document.getElementById('snippet-language')!.value;
    const description = document.getElementById('snippet-description')!.value.trim();
    const body = document.getElementById('snippet-body')!.value;
    if (!prefix) { document.getElementById('snippet-prefix')!.focus(); return; }
    if (!body.trim()) { document.getElementById('snippet-body')!.focus(); return; }
    const list = [...(uiState.snippets || [])];
    if (snippetEditingId) {
      const idx = list.findIndex((s) => s.id === snippetEditingId);
      if (idx !== -1) list[idx] = { ...list[idx], prefix, language, description, body };
    } else {
      list.push({ id: `snip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, prefix, language, description, body });
    }
    uiState.snippets = list;
    await window.nexo.setPrefs({ snippets: list });
    closeSnippetForm();
    renderSnippetsList();
  });
}

// ---------------- Theme ----------------
function applyTheme(theme: any, opts: any = {}) {
  if (theme === 'custom') {
    uiState.theme = 'custom';
    document.body.dataset.theme = 'custom';
    const vars = buildCustomThemeVars(uiState.customTheme);
    applyCustomThemeVars(vars);
    const btn = document.getElementById('btn-theme-toggle');
    if (btn) btn.textContent = CUSTOM_THEME_META.icon;
    if (monacoLoaded && window.monaco) applyCustomMonacoTheme(vars);
    if (!opts.skipSave) window.nexo.setPrefs({ theme: 'custom', customTheme: uiState.customTheme });
    return;
  }
  clearCustomThemeVars();
  const meta = THEMES.find((t) => t.id === theme) || THEMES[0];
  uiState.theme = meta.id;
  document.body.dataset.theme = meta.id;
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) btn.textContent = meta.icon;
  if (monacoLoaded && window.monaco) {
    monaco.editor.setTheme(meta.monaco);
  }
  if (!opts.skipSave) window.nexo.setPrefs({ theme: meta.id });
}

function toggleThemeDropdown() {
  const dropdown = document.getElementById('theme-dropdown');
  if (!dropdown!.classList.contains('hidden')) { dropdown!.classList.add('hidden'); return; }
  dropdown!.innerHTML = '';
  const allThemes = [...THEMES, { ...CUSTOM_THEME_META, swatch: uiState.customTheme.accent }];
  for (const t of allThemes) {
    const opt = document.createElement('div');
    opt.className = 'theme-option' + (t.id === uiState.theme ? ' current' : '');
    opt.innerHTML = `<span class="swatch" style="background:${t.swatch}"></span><span>${t.label}</span>`;
    opt.addEventListener('click', () => {
      applyTheme(t.id);
      dropdown!.classList.add('hidden');
    });
    dropdown!.appendChild(opt);
  }
  dropdown!.classList.remove('hidden');
}
document.getElementById('btn-theme-toggle')!.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleThemeDropdown();
});
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('theme-dropdown');
  if (!dropdown!.classList.contains('hidden') && !dropdown!.contains(e.target as Node) && e.target!.id !== 'btn-theme-toggle') {
    dropdown!.classList.add('hidden');
  }
});

// ---------------- Custom app menu (File/Edit/View/Help) ----------------
// Replaces Electron's plain default menu bar with one that matches the
// app's own theme. The real menu built in main.js (buildMenu) is still
// registered — just auto-hidden, with Alt as a fallback to reveal it — so
// every accelerator (Ctrl+S etc.) keeps working exactly as before; this is
// just what's actually visible day to day.
function monacoEditAction(actionId: any) {
  return () => { if (editor) editor.trigger('app-menu', actionId, null); };
}

const APP_MENUS: Record<string, any[]> = {
  file: [
    { label: 'Open Folder…', shortcut: 'Ctrl+O', run: handleOpenFolder },
    { label: 'New File', shortcut: 'Ctrl+N', run: handleNewFile },
    { separator: true },
    { label: 'Save', shortcut: 'Ctrl+S', run: saveActiveTab },
    { label: 'Save As…', shortcut: 'Ctrl+Shift+S', run: saveActiveTabAs },
    { separator: true },
    { label: 'Exit', run: () => window.nexo.quitApp() },
  ],
  edit: [
    { label: 'Undo', shortcut: 'Ctrl+Z', run: monacoEditAction('undo') },
    { label: 'Redo', shortcut: 'Ctrl+Y', run: monacoEditAction('redo') },
    { separator: true },
    { label: 'Cut', shortcut: 'Ctrl+X', run: monacoEditAction('editor.action.clipboardCutAction') },
    { label: 'Copy', shortcut: 'Ctrl+C', run: monacoEditAction('editor.action.clipboardCopyAction') },
    { label: 'Paste', shortcut: 'Ctrl+V', run: monacoEditAction('editor.action.clipboardPasteAction') },
    { label: 'Select All', shortcut: 'Ctrl+A', run: monacoEditAction('editor.action.selectAll') },
    { separator: true },
    { label: 'Find in Files', shortcut: 'Ctrl+Shift+F', run: () => switchRailView('search') },
    { label: 'Source Control', shortcut: 'Ctrl+Shift+G', run: () => switchRailView('git') },
    { label: 'Format Document', run: formatActiveDocument },
  ],
  view: [
    {
      label: 'Toggle Sidebar',
      shortcut: 'Ctrl+B',
      run: () => {
        const sb = document.getElementById('sidebar');
        sb!.style.display = sb!.style.display === 'none' ? 'flex' : 'none';
      },
    },
    { label: 'Toggle Terminal', shortcut: 'Ctrl+`', run: () => toggleTerminal() },
    { label: 'Toggle Split Editor', shortcut: 'Ctrl+\\', run: () => toggleSplit() },
    { label: 'Toggle Zen Mode', shortcut: 'Ctrl+K Z', run: () => toggleZenMode() },
    { separator: true },
    { label: 'Reload Window', run: () => window.nexo.reloadWindow() },
    { label: 'Toggle Developer Tools', run: () => window.nexo.toggleDevTools() },
    { separator: true },
    { label: 'Toggle Full Screen', run: () => window.nexo.toggleFullscreen() },
  ],
  help: [
    { label: 'Check for Updates…', run: () => window.nexo.checkForUpdates(true) },
    { separator: true },
    { label: 'About Nexo Dev', run: () => window.nexo.showAbout() },
  ],
};

function closeAppMenu() {
  document.getElementById('app-menu-dropdown')!.classList.add('hidden');
  document.querySelectorAll('.app-menu-item.open').forEach((el) => el.classList.remove('open'));
}

function openAppMenu(menuId: any, buttonEl: any) {
  const dropdown = document.getElementById('app-menu-dropdown');
  const wasOpenForThisButton = buttonEl.classList.contains('open');
  closeAppMenu();
  if (wasOpenForThisButton) return; // clicking the already-open menu's own button just closes it
  const items = APP_MENUS[menuId] || [];
  dropdown!.innerHTML = '';
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'app-menu-separator';
      dropdown!.appendChild(sep);
      continue;
    }
    const opt = document.createElement('div');
    opt.className = 'app-menu-option';
    opt.innerHTML = `<span>${escapeHtml(item.label)}</span>${item.shortcut ? `<span class="app-menu-shortcut">${escapeHtml(item.shortcut)}</span>` : ''}`;
    opt.addEventListener('click', () => {
      closeAppMenu();
      item.run();
    });
    dropdown!.appendChild(opt);
  }
  const rect = buttonEl.getBoundingClientRect();
  dropdown!.style.left = `${Math.round(rect.left)}px`;
  dropdown!.style.top = `${Math.round(rect.bottom + 4)}px`;
  dropdown!.classList.remove('hidden');
  buttonEl.classList.add('open');
}

document.querySelectorAll('.app-menu-item').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openAppMenu(btn.dataset.menu, btn);
  });
  // Moving the mouse onto a different top-level item while a menu is
  // already open switches straight to it, matching native menu-bar feel.
  btn.addEventListener('mouseenter', () => {
    if (document.querySelector('.app-menu-item.open') && !btn.classList.contains('open')) {
      openAppMenu(btn.dataset.menu, btn);
    }
  });
});
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('app-menu-dropdown');
  if (!dropdown!.classList.contains('hidden') && !dropdown!.contains(e.target as Node) && !e.target!.closest('.app-menu-item')) {
    closeAppMenu();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAppMenu();
});
