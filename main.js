const { app, BrowserWindow, Menu, dialog, ipcMain, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFile, spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const sodium = require('libsodium-wrappers');

// Only one instance of the app should ever run — if a file/folder is opened
// via "Open with Nexo Dev" while the app is already running, Windows just
// launches a second process with the path as an argument. Without this, that
// would open a whole separate window instead of using the existing one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow;
let splashWindow;
let readyReceived = false;
let pendingOpenPath = null; // a file/folder path waiting to be opened once the renderer is ready

const APP_ICON = path.join(__dirname, 'renderer', 'icons', 'icon.ico');

// Pulls a real file/folder path out of process.argv (either the app's own
// launch args, or the ones forwarded from a second instance). Only matters
// for the packaged app — in dev mode `electron .` passes "." as an argument,
// which would otherwise be mistaken for a path someone right-clicked.
function extractPathFromArgv(argv) {
  if (!app.isPackaged) return null;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || arg.startsWith('-')) continue;
    try {
      if (fs.existsSync(arg)) return arg;
    } catch { /* not a real path, skip */ }
  }
  return null;
}

app.on('second-instance', (event, argv) => {
  const p = extractPathFromArgv(argv);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    if (p) mainWindow.webContents.send('open-path', p);
  }
});

// ---------- Global text search across project files ----------
const SEARCH_IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'out', 'coverage']);
const SEARCH_SKIP_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg', 'pdf', 'zip', 'gz', 'tar', 'rar', '7z',
  'exe', 'dll', 'so', 'dylib', 'woff', 'woff2', 'ttf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'mkv',
  'lock', 'ico', 'db', 'sqlite',
]);
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024; // skip anything bigger than 2MB
const SEARCH_MAX_MATCHES = 500;
const SEARCH_MAX_FILES_WITH_MATCHES = 200;

function walkForSearch(root, query, caseSensitive, results, budget, useRegex) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  let lineRe = null;
  if (useRegex) {
    try { lineRe = new RegExp(query, caseSensitive ? 'g' : 'gi'); } catch { return; }
  }
  for (const entry of entries) {
    if (results.matchedFiles >= SEARCH_MAX_FILES_WITH_MATCHES || results.matches.length >= SEARCH_MAX_MATCHES) return;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SEARCH_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walkForSearch(full, query, caseSensitive, results, budget, useRegex);
      continue;
    }
    const ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
    if (SEARCH_SKIP_EXT.has(ext)) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
    let content;
    try {
      content = fs.readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    // crude binary check
    if (content.includes('\u0000')) continue;

    if (useRegex) {
      lineRe.lastIndex = 0;
      if (!lineRe.test(content)) continue;
    } else {
      const haystack = caseSensitive ? content : content.toLowerCase();
      const needle = caseSensitive ? query : query.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }

    const lines = content.split(/\r\n|\r|\n/);
    const fileMatches = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (useRegex) {
        lineRe.lastIndex = 0;
        let m = lineRe.exec(line);
        while (m) {
          fileMatches.push({ line: i + 1, col: m.index + 1, preview: line.trim().slice(0, 200) });
          if (fileMatches.length >= 30) break;
          if (m[0].length === 0) lineRe.lastIndex++; // avoid infinite loop on zero-width matches
          m = lineRe.exec(line);
        }
      } else {
        const hLine = caseSensitive ? line : line.toLowerCase();
        const needle = caseSensitive ? query : query.toLowerCase();
        let idx = hLine.indexOf(needle);
        while (idx !== -1) {
          fileMatches.push({ line: i + 1, col: idx + 1, preview: line.trim().slice(0, 200) });
          if (fileMatches.length >= 30) break; // cap matches per file
          idx = hLine.indexOf(needle, idx + needle.length);
        }
      }
      if (fileMatches.length >= 30) break;
    }
    if (fileMatches.length) {
      results.matches.push({ path: full, matches: fileMatches });
      results.matchedFiles++;
    }
  }
}

// ---------- Git integration (shells out to the system `git`, no native deps) ----------
function runGit(args, cwd, opts = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (opts.authSensitive) {
      // GIT_TERMINAL_PROMPT only suppresses git's own text-based prompt —
      // it does nothing to stop a GUI credential helper (e.g. Windows' Git
      // Credential Manager) from popping up its own window, which is easy
      // to miss behind the app and looks exactly like a silent hang.
      // GIT_ASKPASS/SSH_ASKPASS point at a command that returns nothing,
      // so any credential request fails immediately instead of waiting on
      // a prompt nobody's going to see. Cached credentials (a helper that
      // already has a valid token) are unaffected — this only kicks in
      // when git would otherwise need to *ask*.
      const noPrompt = process.platform === 'win32' ? 'cmd.exe /c exit 1' : 'true';
      env.GIT_ASKPASS = noPrompt;
      env.SSH_ASKPASS = noPrompt;
      env.SSH_ASKPASS_REQUIRE = 'force';
    }
    execFile('git', args, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      timeout: opts.timeoutMs || 0, // 0 = no timeout
      env,
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || (err ? err.message : '') });
    });
  });
}

async function getGitRoot(startPath) {
  const res = await runGit(['rev-parse', '--show-toplevel'], startPath);
  if (!res.ok) return null;
  return res.stdout.trim().replace(/\//g, path.sep);
}

function parsePorcelainStatus(stdout) {
  const staged = [];
  const unstaged = [];
  const conflicts = [];
  const CONFLICT_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
  const lines = stdout.split('\n').filter(Boolean);
  for (const line of lines) {
    const code = line.slice(0, 2);
    let rest = line.slice(3);
    let renamedFrom = null;
    if (rest.includes(' -> ')) {
      const [from, to] = rest.split(' -> ');
      renamedFrom = from;
      rest = to;
    }
    if (CONFLICT_CODES.has(code)) {
      conflicts.push({ path: rest, code, renamedFrom });
      continue;
    }
    const indexCode = code[0];
    const worktreeCode = code[1];
    const labelFor = (c) => ({ M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Unmerged', '?': 'Untracked' }[c] || c);

    if (code === '??') {
      unstaged.push({ path: rest, status: '?', label: 'Untracked', renamedFrom });
      continue;
    }
    if (indexCode !== ' ') {
      staged.push({ path: rest, status: indexCode, label: labelFor(indexCode), renamedFrom });
    }
    if (worktreeCode !== ' ') {
      unstaged.push({ path: rest, status: worktreeCode, label: labelFor(worktreeCode), renamedFrom });
    }
  }
  return { staged, unstaged, conflicts };
}

// ---------- Recent projects store (simple JSON file, no extra deps) ----------
const recentFilePath = () => path.join(app.getPath('userData'), 'recent-projects.json');

function readRecent() {
  try {
    const raw = fs.readFileSync(recentFilePath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeRecent(list) {
  try {
    fs.writeFileSync(recentFilePath(), JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write recent projects:', err);
  }
}

function addRecent(folderPath) {
  let list = readRecent().filter((p) => p !== folderPath);
  list.unshift(folderPath);
  list = list.slice(0, 10);
  writeRecent(list);
  return list;
}

const recentFilesPath = () => path.join(app.getPath('userData'), 'recent-files.json');

function readRecentFiles() {
  try {
    return JSON.parse(fs.readFileSync(recentFilesPath(), 'utf-8'));
  } catch {
    return [];
  }
}

function writeRecentFiles(list) {
  try {
    fs.writeFileSync(recentFilesPath(), JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write recent files:', err);
  }
}

function addRecentFile(filePath, projectRoot) {
  let list = readRecentFiles().filter((f) => f.path !== filePath);
  list.unshift({ path: filePath, projectRoot: projectRoot || null, openedAt: Date.now() });
  list = list.slice(0, 40);
  writeRecentFiles(list);
}

ipcMain.handle('recent-files:get', () => readRecentFiles());
ipcMain.handle('recent-files:add', (evt, filePath, projectRoot) => { addRecentFile(filePath, projectRoot); return { ok: true }; });

// ---------- Preferences store (all user settings) ----------
const DEFAULT_PREFS = {
  theme: 'dark',
  fontSize: 13.5,
  minimap: true,
  wordWrap: false,
  bracketGuides: false,
  vimMode: false,
  formatOnSave: false,
  autoSave: false,
  autoSaveDelayMs: 1000,
  customShell: '',
  customTheme: { bg: '#0c0c10', text: '#ececf0', accent: '#ff3b30' },
  customThemes: [], // saved named presets: [{ id, name, bg, text, accent }]
  scriptsOrder: [],
  snippets: [], // [{ id, prefix, body, language }]
};
const prefsFilePath = () => path.join(app.getPath('userData'), 'prefs.json');
function readPrefs() {
  try {
    const saved = JSON.parse(fs.readFileSync(prefsFilePath(), 'utf-8'));
    return { ...DEFAULT_PREFS, ...saved, customTheme: { ...DEFAULT_PREFS.customTheme, ...(saved.customTheme || {}) } };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
function writePrefs(prefs) {
  try {
    fs.writeFileSync(prefsFilePath(), JSON.stringify(prefs, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write prefs:', err);
  }
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function sanitizePrefsPartial(partial) {
  const clean = {};
  if (partial.theme !== undefined) {
    clean.theme = ['dark', 'light', 'midnight', 'contrast', 'custom'].includes(partial.theme) ? partial.theme : 'dark';
  }
  if (partial.fontSize !== undefined) {
    clean.fontSize = Math.max(9, Math.min(28, Number(partial.fontSize) || 13.5));
  }
  if (partial.minimap !== undefined) clean.minimap = !!partial.minimap;
  if (partial.wordWrap !== undefined) clean.wordWrap = !!partial.wordWrap;
  if (partial.bracketGuides !== undefined) clean.bracketGuides = !!partial.bracketGuides;
  if (partial.vimMode !== undefined) clean.vimMode = !!partial.vimMode;
  if (partial.formatOnSave !== undefined) clean.formatOnSave = !!partial.formatOnSave;
  if (partial.autoSave !== undefined) clean.autoSave = !!partial.autoSave;
  if (partial.autoSaveDelayMs !== undefined) {
    clean.autoSaveDelayMs = Math.max(200, Math.min(10000, Number(partial.autoSaveDelayMs) || 1000));
  }
  if (partial.customShell !== undefined) clean.customShell = String(partial.customShell).trim().slice(0, 500);
  if (partial.customTheme !== undefined && typeof partial.customTheme === 'object' && partial.customTheme) {
    const src = partial.customTheme;
    const def = DEFAULT_PREFS.customTheme;
    clean.customTheme = {
      bg: HEX_COLOR_RE.test(src.bg) ? src.bg : def.bg,
      text: HEX_COLOR_RE.test(src.text) ? src.text : def.text,
      accent: HEX_COLOR_RE.test(src.accent) ? src.accent : def.accent,
    };
  }
  if (partial.customThemes !== undefined && Array.isArray(partial.customThemes)) {
    clean.customThemes = partial.customThemes
      .filter((p) => p && typeof p === 'object')
      .slice(0, 30) // reasonable cap so this can't grow unbounded
      .map((p) => ({
        id: typeof p.id === 'string' && p.id ? p.id.slice(0, 100) : `theme_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 60) : 'Untitled theme',
        bg: HEX_COLOR_RE.test(p.bg) ? p.bg : DEFAULT_PREFS.customTheme.bg,
        text: HEX_COLOR_RE.test(p.text) ? p.text : DEFAULT_PREFS.customTheme.text,
        accent: HEX_COLOR_RE.test(p.accent) ? p.accent : DEFAULT_PREFS.customTheme.accent,
      }));
  }
  if (partial.scriptsOrder !== undefined && Array.isArray(partial.scriptsOrder)) {
    clean.scriptsOrder = partial.scriptsOrder
      .filter((s) => typeof s === 'string')
      .slice(0, 200)
      .map((s) => s.slice(0, 200));
  }
  if (partial.snippets !== undefined && Array.isArray(partial.snippets)) {
    clean.snippets = partial.snippets
      .filter((s) => s && typeof s === 'object')
      .slice(0, 300)
      .map((s) => ({
        id: typeof s.id === 'string' && s.id ? s.id.slice(0, 100) : `snip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        prefix: typeof s.prefix === 'string' ? s.prefix.trim().slice(0, 60) : '',
        body: typeof s.body === 'string' ? s.body.slice(0, 20000) : '',
        language: typeof s.language === 'string' && s.language ? s.language.slice(0, 40) : 'all',
        description: typeof s.description === 'string' ? s.description.slice(0, 200) : '',
      }))
      .filter((s) => s.prefix && s.body);
  }
  return clean;
}

ipcMain.handle('prefs:get', () => readPrefs());
ipcMain.handle('prefs:set', (evt, partial) => {
  const merged = { ...readPrefs(), ...sanitizePrefsPartial(partial || {}) };
  writePrefs(merged);
  return merged;
});

// ---------- Session store (crash recovery) ----------
// Keyed by project root path, so each project remembers its own last set of
// open tabs. Written proactively on every tab change (not just on clean
// shutdown) specifically so a crash or force-close still leaves a usable
// snapshot on disk to restore from next time that project opens.
const sessionsFilePath = () => path.join(app.getPath('userData'), 'sessions.json');
function readSessions() {
  try {
    return JSON.parse(fs.readFileSync(sessionsFilePath(), 'utf-8'));
  } catch {
    return {};
  }
}
function writeSessions(sessions) {
  try {
    fs.writeFileSync(sessionsFilePath(), JSON.stringify(sessions, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write sessions:', err);
  }
}

ipcMain.handle('session:save', (evt, projectRoot, data) => {
  if (!projectRoot) return { ok: false };
  const sessions = readSessions();
  if (!data || !data.openTabs || !data.openTabs.length) {
    delete sessions[projectRoot]; // nothing open — don't keep a stale entry around
  } else {
    sessions[projectRoot] = {
      openTabs: data.openTabs.slice(0, 50).map((t) => ({
        path: String(t.path || '').slice(0, 1000),
        pinned: !!t.pinned,
        cursor: (t.cursor && Number.isFinite(t.cursor.line) && Number.isFinite(t.cursor.column))
          ? { line: Math.max(1, Math.floor(t.cursor.line)), column: Math.max(1, Math.floor(t.cursor.column)) }
          : null,
      })),
      activeTab: data.activeTab ? String(data.activeTab).slice(0, 1000) : null,
      savedAt: Date.now(),
    };
  }
  // Cap how many projects' sessions we remember, dropping the oldest.
  const entries = Object.entries(sessions).sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
  writeSessions(Object.fromEntries(entries.slice(0, 50)));
  return { ok: true };
});

ipcMain.handle('session:load', (evt, projectRoot) => {
  const sessions = readSessions();
  return sessions[projectRoot] || null;
});

// ---------- Window ----------
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 380,
    height: 440,
    frame: false,
    resizable: false,
    movable: true,
    center: true,
    show: true,
    backgroundColor: '#050505',
    icon: APP_ICON,
    skipTaskbar: false,
    webPreferences: { contextIsolation: true },
  });
  splashWindow.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  splashWindow.on('closed', () => { splashWindow = null; });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#12121a',
    title: 'Nexo Dev',
    icon: APP_ICON,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  buildMenu();

  // Safety net: if the renderer never signals ready (unexpected error, etc.)
  // show the window anyway after a few seconds instead of leaving the user
  // stuck on the splash screen forever.
  setTimeout(() => {
    if (!readyReceived) revealMainWindow();
  }, 6000);
}

function revealMainWindow() {
  readyReceived = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
}

ipcMain.on('app:ready', () => {
  revealMainWindow();
  if (pendingOpenPath && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('open-path', pendingOpenPath);
    pendingOpenPath = null;
  }
});

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow.webContents.send('menu:open-folder') },
        { label: 'New File', accelerator: 'CmdOrCtrl+N', click: () => mainWindow.webContents.send('menu:new-file') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => mainWindow.webContents.send('menu:save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => mainWindow.webContents.send('menu:save-as') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' },
        { label: 'Find in Files', accelerator: 'CmdOrCtrl+Shift+F', click: () => mainWindow.webContents.send('menu:show-search') },
        { label: 'Source Control', accelerator: 'CmdOrCtrl+Shift+G', click: () => mainWindow.webContents.send('menu:show-git') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => mainWindow.webContents.send('menu:toggle-sidebar') },
        { label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+`', click: () => mainWindow.webContents.send('menu:toggle-terminal') },
        { label: 'Toggle Split Editor', accelerator: 'CmdOrCtrl+\\', click: () => mainWindow.webContents.send('menu:toggle-split') },
        { label: 'Toggle Zen Mode', accelerator: 'CmdOrCtrl+K Z', click: () => mainWindow.webContents.send('menu:toggle-zen') },
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Check for Updates…', click: () => mainWindow.webContents.send('menu:check-updates') },
        { type: 'separator' },
        { label: 'About Nexo Dev', click: () => dialog.showMessageBox(mainWindow, {
          title: 'Nexo Dev',
          message: 'Nexo Dev',
          detail: 'A lightweight code editor and project manager.\nBuilt for the Nexo network.',
        }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- Auto-update (GitHub Releases via electron-updater) ----------
// Downloads only happen when the user explicitly agrees — never silently in
// the background, since that could interrupt someone mid-work with a forced
// restart later. The renderer drives the UI; this just relays events.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
let manualUpdateCheck = false;

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}
autoUpdater.on('update-available', (info) => sendToRenderer('update:available', info.version));
autoUpdater.on('update-not-available', () => {
  if (manualUpdateCheck) sendToRenderer('update:not-available');
  manualUpdateCheck = false;
});
autoUpdater.on('download-progress', (progress) => sendToRenderer('update:progress', progress.percent));
autoUpdater.on('update-downloaded', () => sendToRenderer('update:downloaded'));
autoUpdater.on('error', (err) => {
  if (manualUpdateCheck) sendToRenderer('update:error', err.message);
  manualUpdateCheck = false;
});

ipcMain.handle('update:check', (evt, manual) => {
  if (!app.isPackaged) return { ok: false, error: 'Updates only run in the packaged app, not `npm start`.' };
  manualUpdateCheck = !!manual;
  autoUpdater.checkForUpdates().catch((err) => {
    if (manualUpdateCheck) sendToRenderer('update:error', err.message);
    manualUpdateCheck = false;
  });
  return { ok: true };
});
ipcMain.handle('update:download', () => { autoUpdater.downloadUpdate(); });
ipcMain.handle('update:install', () => { autoUpdater.quitAndInstall(); });

app.whenReady().then(() => {
  createSplash();
  createWindow();
  const initialPath = extractPathFromArgv(process.argv);
  if (initialPath) pendingOpenPath = initialPath;

  // Check once, a bit after launch — not immediately, so it doesn't compete
  // with everything else that's loading on startup.
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------- Command runner (a safer alternative to a full terminal) ----------
// Runs one-off shell commands via child_process instead of a native pty, so
// there's no node-pty build step required on the user's machine. Not a full
// interactive terminal (no input to a running process, no TUI apps), but
// covers the common case: npm scripts, git, build tools, etc.
const runningProcs = new Map(); // id -> ChildProcess

ipcMain.handle('term:run', (evt, cwd, command) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const isWin = process.platform === 'win32';
  const customShell = readPrefs().customShell;
  const shell = customShell || (isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh'));
  const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

  let child;
  try {
    child = spawn(shell, args, { cwd, windowsHide: true });
  } catch (err) {
    return { id: null, error: err.message };
  }
  runningProcs.set(id, child);

  const send = (channel, ...payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, id, ...payload);
  };
  child.stdout.on('data', (d) => send('term:data', d.toString()));
  child.stderr.on('data', (d) => send('term:data', d.toString()));
  child.on('close', (code) => {
    runningProcs.delete(id);
    send('term:exit', code);
  });
  child.on('error', (err) => {
    runningProcs.delete(id);
    send('term:data', `\n[error] ${err.message}\n`);
    send('term:exit', -1);
  });

  return { id };
});

ipcMain.handle('term:kill', (evt, id) => {
  const child = runningProcs.get(id);
  if (!child) return { ok: false };
  try {
    child.kill();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.on('before-quit', () => {
  for (const child of runningProcs.values()) {
    try { child.kill(); } catch { /* already gone */ }
  }
  for (const watcher of fileWatchers.values()) {
    try { watcher.close(); } catch { /* already gone */ }
  }
});

// ---------- IPC: dialogs ----------
ipcMain.handle('dialog:open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  const folder = result.filePaths[0];
  const recent = addRecent(folder);
  return { folder, recent };
});

ipcMain.handle('dialog:new-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  const parent = result.filePaths[0];
  const nameResult = await dialog.showSaveDialog(mainWindow, {
    title: 'Name your project folder',
    defaultPath: path.join(parent, 'new-project'),
  });
  if (nameResult.canceled || !nameResult.filePath) return null;
  fs.mkdirSync(nameResult.filePath, { recursive: true });
  const recent = addRecent(nameResult.filePath);
  return { folder: nameResult.filePath, recent };
});

// Plain "pick a folder" dialog that doesn't touch the recent-projects list —
// used for choosing where to clone a repo into, not opening one directly.
ipcMain.handle('dialog:pick-folder', async (evt, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: title || 'Choose a folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('git:clone', async (evt, url, destParentDir) => {
  let name = (url.trim().split('/').pop() || 'repository').replace(/\.git$/i, '');
  name = name.replace(/[<>:"|?*]/g, '').trim() || 'repository';
  let destDir = path.join(destParentDir, name);
  let suffix = 1;
  while (fs.existsSync(destDir)) {
    destDir = path.join(destParentDir, `${name}-${suffix}`);
    suffix++;
  }
  const trimmedUrl = url.trim();
  const authArgs = /^https:\/\/(www\.)?github\.com\//i.test(trimmedUrl) ? githubAuthHeaderArgs(readGithubToken()) : [];
  const res = await runGit([...authArgs, 'clone', trimmedUrl, destDir], destParentDir, { authSensitive: true, timeoutMs: 300000 });
  if (!res.ok) return { ok: false, error: res.stderr || res.stdout || 'Clone failed.' };
  const recent = addRecent(destDir);
  return { ok: true, path: destDir, recent };
});

ipcMain.handle('dialog:save-as', async (evt, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle('shell:reveal', (evt, targetPath) => {
  shell.showItemInFolder(targetPath);
});

// ---------- IPC: recent projects ----------
ipcMain.handle('recent:get', () => readRecent());
ipcMain.handle('recent:remove', (evt, folderPath) => {
  const list = readRecent().filter((p) => p !== folderPath);
  writeRecent(list);
  return list;
});

// ---------- IPC: filesystem ----------
// Lazy directory listing — returns immediate children only.
ipcMain.handle('fs:read-dir', async (evt, dirPath) => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const IGNORE = new Set(['node_modules', '.git', '.DS_Store', 'dist', 'build']);
  return entries
    .filter((e) => !IGNORE.has(e.name))
    .map((e) => ({
      name: e.name,
      path: path.join(dirPath, e.name),
      isDirectory: e.isDirectory(),
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
});

ipcMain.handle('fs:read-file', async (evt, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- External file-change watching ----------
// Only watches files the renderer tells us are currently open (not the whole
// project — that would be wasteful and noisy). Guards against notifying
// about changes we caused ourselves (Save, Auto Save) by tracking recent
// writes and skipping watch events that land right after one.
const fileWatchers = new Map(); // path -> fs.FSWatcher
const recentWrites = new Map(); // path -> timestamp of our own last write
const SELF_WRITE_GUARD_MS = 1000;

ipcMain.handle('fs:write-file', async (evt, filePath, content) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    recentWrites.set(filePath, Date.now());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('watch:start', (evt, filePath) => {
  if (fileWatchers.has(filePath)) return { ok: true };
  try {
    let debounceTimer = null;
    const watcher = fs.watch(filePath, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (Date.now() - (recentWrites.get(filePath) || 0) < SELF_WRITE_GUARD_MS) return;
        if (!fs.existsSync(filePath)) return; // deleted, not modified — not our concern here
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('file-changed', filePath);
      }, 300);
    });
    watcher.on('error', () => { fileWatchers.delete(filePath); });
    fileWatchers.set(filePath, watcher);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('watch:stop', (evt, filePath) => {
  const watcher = fileWatchers.get(filePath);
  if (watcher) {
    try { watcher.close(); } catch { /* already closed */ }
    fileWatchers.delete(filePath);
  }
  recentWrites.delete(filePath);
  return { ok: true };
});

ipcMain.handle('fs:create-file', async (evt, dirPath, name) => {
  try {
    const target = path.join(dirPath, name);
    if (fs.existsSync(target)) return { ok: false, error: 'A file with that name already exists.' };
    fs.writeFileSync(target, '', 'utf-8');
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:create-folder', async (evt, dirPath, name) => {
  try {
    const target = path.join(dirPath, name);
    if (fs.existsSync(target)) return { ok: false, error: 'A folder with that name already exists.' };
    fs.mkdirSync(target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:delete', async (evt, targetPath) => {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:rename', async (evt, oldPath, newName) => {
  try {
    const newPath = path.join(path.dirname(oldPath), newName);
    if (fs.existsSync(newPath)) return { ok: false, error: 'A file/folder with that name already exists.' };
    fs.renameSync(oldPath, newPath);
    return { ok: true, path: newPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:exists', async (evt, targetPath) => fs.existsSync(targetPath));

ipcMain.handle('fs:stat', async (evt, targetPath) => {
  try {
    const s = fs.statSync(targetPath);
    return { ok: true, isDirectory: s.isDirectory(), isFile: s.isFile() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:move', async (evt, sourcePath, destDir) => {
  try {
    const name = path.basename(sourcePath);
    const destPath = path.join(destDir, name);
    if (destPath === sourcePath) return { ok: true, path: sourcePath }; // no-op, dropped on itself
    if (destPath.startsWith(sourcePath + path.sep)) {
      return { ok: false, error: "Can't move a folder into itself." };
    }
    if (fs.existsSync(destPath)) return { ok: false, error: 'An item with that name already exists there.' };
    fs.renameSync(sourcePath, destPath);
    return { ok: true, path: destPath };
  } catch (err) {
    return { ok: false, error: err.code === 'EXDEV' ? "Can't move files across drives." : err.message };
  }
});

// ---------- IPC: shell ----------
ipcMain.handle('shell:open-external', (evt, url) => shell.openExternal(url));

// ---------- IPC: global search ----------
ipcMain.handle('todos:scan', async (evt, projectRoot) => {
  if (!projectRoot) return { ok: false, error: 'No project open.' };
  const results = { matches: [], matchedFiles: 0 };
  const pattern = '\\b(TODO|FIXME|HACK)\\b:?\\s*(.*)';
  walkForSearch(projectRoot, pattern, false, results, {}, true);
  const tagRe = /\b(TODO|FIXME|HACK)\b:?\s*(.*)/i;
  const todos = [];
  for (const fileMatch of results.matches) {
    for (const m of fileMatch.matches) {
      const tagMatch = m.preview.match(tagRe);
      todos.push({
        path: fileMatch.path,
        line: m.line,
        tag: tagMatch ? tagMatch[1].toUpperCase() : 'TODO',
        text: tagMatch ? tagMatch[2].trim() : m.preview,
      });
    }
  }
  return { ok: true, todos, truncated: results.matchedFiles >= SEARCH_MAX_FILES_WITH_MATCHES };
});

ipcMain.handle('search:text', async (evt, rootPath, query, opts = {}) => {
  if (!query || !query.trim()) return { matches: [], truncated: false };
  if (opts.useRegex) {
    try { new RegExp(query); } catch (err) { return { matches: [], truncated: false, error: err.message }; }
  }
  const results = { matches: [], matchedFiles: 0 };
  walkForSearch(rootPath, query, !!opts.caseSensitive, results, {}, !!opts.useRegex);
  return {
    matches: results.matches,
    truncated: results.matchedFiles >= SEARCH_MAX_FILES_WITH_MATCHES || results.matches.length >= SEARCH_MAX_MATCHES,
  };
});

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walkForReplace(root, re, replacement, results) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.filesChanged >= SEARCH_MAX_FILES_WITH_MATCHES) return;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SEARCH_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walkForReplace(full, re, replacement, results);
      continue;
    }
    const ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
    if (SEARCH_SKIP_EXT.has(ext)) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
    let content;
    try {
      content = fs.readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue;

    re.lastIndex = 0;
    const matches = content.match(re);
    if (!matches || !matches.length) continue;

    try {
      const updated = content.replace(re, replacement);
      fs.writeFileSync(full, updated, 'utf-8');
      recentWrites.set(full, Date.now()); // same self-write guard the file watcher already respects
      results.filesChanged++;
      results.totalReplacements += matches.length;
      results.changedPaths.push(full);
    } catch (err) {
      results.errors.push({ path: full, error: err.message });
    }
  }
}

ipcMain.handle('search:replace-all', async (evt, rootPath, query, replacement, opts = {}) => {
  if (!query) return { filesChanged: 0, totalReplacements: 0, changedPaths: [], errors: [] };
  let re;
  let safeReplacement;
  if (opts.useRegex) {
    try {
      re = new RegExp(query, opts.caseSensitive ? 'g' : 'gi');
    } catch (err) {
      return { filesChanged: 0, totalReplacements: 0, changedPaths: [], errors: [{ path: '', error: `Invalid regex: ${err.message}` }] };
    }
    // Regex mode: $1, $2, etc. are honored as capture-group references.
    safeReplacement = String(replacement);
  } else {
    re = new RegExp(escapeRegExp(query), opts.caseSensitive ? 'g' : 'gi');
    // Escape $ in the replacement so String.replace doesn't treat it as a
    // special pattern ($&, $1, etc.) — this is a literal find & replace, not
    // a regex-capture-group replace.
    safeReplacement = String(replacement).replace(/\$/g, '$$$$');
  }
  const results = { filesChanged: 0, totalReplacements: 0, changedPaths: [], errors: [] };
  walkForReplace(rootPath, re, safeReplacement, results);
  return results;
});

// Flat recursive file list (paths only) for Quick Open — reuses the same
// ignore rules as global search so it skips node_modules/.git/build output.
const QUICK_OPEN_MAX_FILES = 5000;
function walkForFileList(root, out) {
  if (out.length >= QUICK_OPEN_MAX_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= QUICK_OPEN_MAX_FILES) return;
    if (entry.isDirectory()) {
      if (SEARCH_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walkForFileList(path.join(root, entry.name), out);
      continue;
    }
    out.push(path.join(root, entry.name));
  }
}

ipcMain.handle('fs:list-files', async (evt, rootPath) => {
  const out = [];
  walkForFileList(rootPath, out);
  return { files: out, truncated: out.length >= QUICK_OPEN_MAX_FILES };
});

// ---------- IPC: git ----------
// ---------- GitHub API integration ----------
// The token is encrypted at rest with the OS keychain (safeStorage) rather
// than living in plain text in prefs.json — it's a real credential, not a
// UI preference.
function githubTokenPath() { return path.join(app.getPath('userData'), 'github-token.enc'); }

function saveGithubToken(token) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level credential encryption is unavailable on this system, so the token cannot be stored securely.');
  }
  fs.writeFileSync(githubTokenPath(), safeStorage.encryptString(token));
}

function readGithubToken() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const enc = fs.readFileSync(githubTokenPath());
    return safeStorage.decryptString(enc);
  } catch {
    return null;
  }
}

function clearGithubToken() {
  try { fs.unlinkSync(githubTokenPath()); } catch { /* already gone */ }
}

function githubApiRequest(method, urlPath, body, tokenOverride) {
  return new Promise((resolve) => {
    const token = tokenOverride || readGithubToken();
    if (!token) { resolve({ ok: false, status: 0, error: 'No GitHub token saved. Add one in Settings.' }); return; }
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: urlPath,
      method,
      headers: {
        'User-Agent': 'Nexo-Dev',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 15000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* non-JSON body */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, status: res.statusCode, data: json });
        else resolve({ ok: false, status: res.statusCode, error: (json && json.message) || `GitHub API error ${res.statusCode}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request to GitHub timed out.')));
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    if (data) req.write(data);
    req.end();
  });
}

// Only inject the token for github.com HTTPS remotes — never for SSH remotes
// (which use your existing SSH keys) or other hosts (self-hosted GitLab,
// Bitbucket, etc.) where this PAT has no business being sent.
function githubAuthHeaderArgs(token) {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  // Scoped via -c to this single invocation — never written to .git/config,
  // never appears in `git remote -v`, and doesn't touch the stored remote URL.
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

async function githubAuthArgsForRemote(root) {
  const token = readGithubToken();
  if (!token) return [];
  const remoteRes = await runGit(['remote', 'get-url', 'origin'], root);
  if (!remoteRes.ok || !/^https:\/\/(www\.)?github\.com\//i.test(remoteRes.stdout.trim())) return [];
  // git's extraHeader config is multi-valued — if this repo already has a
  // leftover http.extraheader entry from something else (an old manual PAT
  // setup, GitHub Desktop, gh CLI, whatever), our own -c-scoped header below
  // gets sent ALONGSIDE it rather than replacing it, so the request ends up
  // with two Authorization headers and GitHub can reject or misbehave on
  // that. Clearing any existing entry first (silently — it's fine if there
  // isn't one) keeps this repo's git config from fighting with our own auth.
  await runGit(['config', '--unset-all', 'http.https://github.com/.extraheader'], root);
  return githubAuthHeaderArgs(token);
}

function parseGithubOwnerRepo(remoteUrl) {
  const m = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

async function getGithubOwnerRepo(root) {
  const res = await runGit(['remote', 'get-url', 'origin'], root);
  if (!res.ok) return null;
  return parseGithubOwnerRepo(res.stdout);
}

ipcMain.handle('github:set-token', async (evt, token) => {
  const trimmed = (token || '').trim();
  if (!trimmed) return { ok: false, error: 'Token cannot be empty.' };
  const res = await githubApiRequest('GET', '/user', null, trimmed);
  if (!res.ok) return { ok: false, error: res.status === 401 ? 'That token was rejected by GitHub — check it was copied correctly and has not expired.' : res.error };
  try {
    saveGithubToken(trimmed);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, user: { login: res.data.login, avatar: res.data.avatar_url, name: res.data.name } };
});

ipcMain.handle('github:get-user', async () => {
  if (!readGithubToken()) return { ok: false, error: 'No token saved.' };
  const res = await githubApiRequest('GET', '/user');
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, user: { login: res.data.login, avatar: res.data.avatar_url, name: res.data.name } };
});

ipcMain.handle('github:clear-token', () => { clearGithubToken(); return { ok: true }; });
ipcMain.handle('github:has-token', () => ({ hasToken: !!readGithubToken() }));

ipcMain.handle('github:list-releases', async (evt, projectRoot) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const or = await getGithubOwnerRepo(root);
  if (!or) return { ok: false, error: 'The origin remote is not a GitHub URL.' };
  const res = await githubApiRequest('GET', `/repos/${or.owner}/${or.repo}/releases?per_page=50`);
  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    releases: res.data.map((r) => ({
      id: r.id, tagName: r.tag_name, name: r.name || r.tag_name, body: r.body || '',
      draft: r.draft, prerelease: r.prerelease, url: r.html_url, publishedAt: r.published_at || r.created_at,
    })),
  };
});

ipcMain.handle('github:create-release', async (evt, projectRoot, opts) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const or = await getGithubOwnerRepo(root);
  if (!or) return { ok: false, error: 'The origin remote is not a GitHub URL.' };
  if (!opts || !opts.tagName || !opts.tagName.trim()) return { ok: false, error: 'Tag name is required.' };
  const body = {
    tag_name: opts.tagName.trim(),
    name: (opts.name || opts.tagName).trim(),
    body: opts.body || '',
    draft: !!opts.draft,
    prerelease: !!opts.prerelease,
  };
  // If the tag doesn't exist yet, GitHub creates it automatically pointed at
  // this commitish — same behavior as typing a new tag in the web UI.
  if (opts.targetCommitish) body.target_commitish = opts.targetCommitish;
  const res = await githubApiRequest('POST', `/repos/${or.owner}/${or.repo}/releases`, body);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, release: { url: res.data.html_url, tagName: res.data.tag_name } };
});

// Encrypts a value for a GitHub Actions secret using libsodium's sealed-box
// scheme against the repo's public key — this is GitHub's documented
// requirement for the Actions secrets API (crypto_box_seal), not a arbitrary
// choice. The plaintext secret is never sent to GitHub or written to disk —
// only the sealed ciphertext leaves this function.
async function encryptSecretForGithub(publicKeyBase64, secretValue) {
  await sodium.ready;
  const keyBytes = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const messageBytes = sodium.from_string(secretValue);
  const sealedBytes = sodium.crypto_box_seal(messageBytes, keyBytes);
  return sodium.to_base64(sealedBytes, sodium.base64_variants.ORIGINAL);
}

ipcMain.handle('github:set-secret', async (evt, projectRoot, secretName, secretValue) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const or = await getGithubOwnerRepo(root);
  if (!or) return { ok: false, error: 'The origin remote is not a GitHub URL.' };
  const keyRes = await githubApiRequest('GET', `/repos/${or.owner}/${or.repo}/actions/secrets/public-key`);
  if (!keyRes.ok) return { ok: false, error: keyRes.error };
  let encrypted;
  try {
    encrypted = await encryptSecretForGithub(keyRes.data.key, secretValue);
  } catch (err) {
    return { ok: false, error: `Could not encrypt secret: ${err.message}` };
  }
  const putRes = await githubApiRequest('PUT', `/repos/${or.owner}/${or.repo}/actions/secrets/${encodeURIComponent(secretName)}`, {
    encrypted_value: encrypted,
    key_id: keyRes.data.key_id,
  });
  if (!putRes.ok) return { ok: false, error: putRes.error };
  return { ok: true };
});

ipcMain.handle('github:list-repos', async () => {
  const res = await githubApiRequest('GET', '/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member');
  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    repos: res.data.map((r) => ({
      fullName: r.full_name, cloneUrl: r.clone_url, private: r.private,
      description: r.description, updatedAt: r.updated_at,
    })),
  };
});

ipcMain.handle('github:create-repo', async (evt, { name, description, isPrivate }) => {
  if (!name || !name.trim()) return { ok: false, error: 'Repository name is required.' };
  const res = await githubApiRequest('POST', '/user/repos', { name: name.trim(), description: description || '', private: !!isPrivate });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, repo: { fullName: res.data.full_name, cloneUrl: res.data.clone_url, htmlUrl: res.data.html_url } };
});

ipcMain.handle('github:list-pulls', async (evt, projectRoot) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const or = await getGithubOwnerRepo(root);
  if (!or) return { ok: false, error: 'The origin remote is not a GitHub URL.' };
  const res = await githubApiRequest('GET', `/repos/${or.owner}/${or.repo}/pulls?state=open&per_page=50`);
  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    pulls: res.data.map((p) => ({
      number: p.number, title: p.title, author: p.user.login, url: p.html_url,
      draft: p.draft, branch: p.head.ref, updatedAt: p.updated_at,
    })),
  };
});

ipcMain.handle('github:list-issues', async (evt, projectRoot) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const or = await getGithubOwnerRepo(root);
  if (!or) return { ok: false, error: 'The origin remote is not a GitHub URL.' };
  const res = await githubApiRequest('GET', `/repos/${or.owner}/${or.repo}/issues?state=open&per_page=50`);
  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    // The issues endpoint also returns PRs — filter those out, they're covered by list-pulls.
    issues: res.data.filter((i) => !i.pull_request).map((i) => ({
      number: i.number, title: i.title, author: i.user.login, url: i.html_url,
      updatedAt: i.updated_at, labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    })),
  };
});

function findLocalPrettierBin(root) {
  const bin = process.platform === 'win32' ? 'prettier.cmd' : 'prettier';
  const p = path.join(root, 'node_modules', '.bin', bin);
  return fs.existsSync(p) ? p : null;
}

ipcMain.handle('prettier:format', async (evt, projectRoot, filePath, content) => {
  if (!projectRoot) return { ok: false, reason: 'not-found' };
  const bin = findLocalPrettierBin(projectRoot);
  if (!bin) return { ok: false, reason: 'not-found' };
  return new Promise((resolve) => {
    const child = execFile(bin, ['--stdin-filepath', filePath], { cwd: projectRoot, timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      // A parser-inference failure (unsupported file type) or a syntax error
      // in the file both come through here as a non-zero exit — treat both
      // as "can't format this one," not a crash-worthy error.
      if (err) { resolve({ ok: false, reason: 'error', error: stderr || err.message }); return; }
      resolve({ ok: true, formatted: stdout });
    });
    child.stdin.write(content);
    child.stdin.end();
  });
});

function findLocalEslintBin(root) {
  const bin = process.platform === 'win32' ? 'eslint.cmd' : 'eslint';
  const p = path.join(root, 'node_modules', '.bin', bin);
  return fs.existsSync(p) ? p : null;
}

const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

ipcMain.handle('npm:outdated', async (evt, projectRoot) => {
  if (!projectRoot) return { ok: false, error: 'No project open.' };
  if (!fs.existsSync(path.join(projectRoot, 'package.json'))) return { ok: false, reason: 'no-package-json' };
  return new Promise((resolve) => {
    execFile(NPM_BIN, ['outdated', '--json'], { cwd: projectRoot, timeout: 20000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      // npm outdated exits with code 1 whenever it finds outdated packages —
      // that's normal, not a failure. Only a genuinely empty result with a
      // non-1 exit code (e.g. npm itself not found, network error) is a
      // real error worth surfacing.
      const trimmed = (stdout || '').trim();
      if (!trimmed) {
        if (err && err.code !== 1) resolve({ ok: false, error: stderr || err.message });
        else resolve({ ok: true, packages: [] });
        return;
      }
      try {
        const data = JSON.parse(trimmed);
        const packages = Object.entries(data).map(([name, info]) => ({
          name,
          current: info.current || '(not installed)',
          wanted: info.wanted || '',
          latest: info.latest || '',
          type: info.type || 'dependencies',
        }));
        resolve({ ok: true, packages });
      } catch {
        resolve({ ok: false, error: 'Could not parse npm outdated output.' });
      }
    });
  });
});

ipcMain.handle('eslint:lint', async (evt, projectRoot, filePath, content) => {
  if (!projectRoot) return { ok: false, reason: 'not-found' };
  const bin = findLocalEslintBin(projectRoot);
  if (!bin) return { ok: false, reason: 'not-found' };
  const useStdin = typeof content === 'string';
  const args = useStdin
    ? ['--format', 'json', '--no-color', '--stdin', '--stdin-filename', filePath]
    : ['--format', 'json', '--no-color', filePath];
  return new Promise((resolve) => {
    const child = execFile(bin, args, { cwd: projectRoot, timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      // ESLint exits with code 1 when it finds lint problems — that's not a
      // real failure, stdout still has valid JSON either way.
      if (!stdout) { resolve({ ok: false, reason: 'error', error: err ? err.message : 'No output from ESLint.' }); return; }
      try {
        const results = JSON.parse(stdout);
        const resolved = path.resolve(filePath);
        const fileResult = results.find((r) => path.resolve(r.filePath) === resolved) || results[0];
        const messages = fileResult ? fileResult.messages : [];
        resolve({
          ok: true,
          messages: messages
            .filter((m) => Number.isFinite(m.line)) // fatal parse errors sometimes omit position info
            .map((m) => ({
              line: m.line, column: m.column || 1,
              endLine: m.endLine || m.line, endColumn: m.endColumn || (m.column || 1) + 1,
              severity: m.severity, message: m.message, ruleId: m.ruleId || null,
            })),
        });
      } catch {
        resolve({ ok: false, reason: 'error', error: 'Could not parse ESLint output.' });
      }
    });
    if (useStdin) {
      child.stdin.write(content);
      child.stdin.end();
    }
  });
});

ipcMain.handle('git:status', async (evt, projectRoot) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const res = await runGit(['status', '--porcelain'], root);
  if (!res.ok) return { ok: false, error: res.stderr || 'git status failed.' };
  const { staged, unstaged, conflicts } = parsePorcelainStatus(res.stdout);
  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  return { ok: true, root, branch: branchRes.ok ? branchRes.stdout.trim() : '', staged, unstaged, conflicts };
});

// Parses `git blame --line-porcelain` output. Full commit metadata is only
// emitted the first time each commit appears in the stream — later lines
// from the same commit just repeat the hash line then jump straight to the
// tab-prefixed content line — so metadata is cached by hash and reused.
function parseBlamePorcelain(output) {
  const lines = output.split('\n');
  const commits = {};
  const result = {};
  let i = 0;
  while (i < lines.length) {
    const header = lines[i].match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/);
    if (!header) { i++; continue; }
    const hash = header[1];
    const finalLine = parseInt(header[2], 10);
    i++;
    if (!commits[hash]) commits[hash] = { hash, author: '', time: 0, summary: '' };
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const l = lines[i];
      if (l.startsWith('author ')) commits[hash].author = l.slice(7);
      else if (l.startsWith('author-time ')) commits[hash].time = parseInt(l.slice(12), 10) || 0;
      else if (l.startsWith('summary ')) commits[hash].summary = l.slice(8);
      i++;
    }
    if (i < lines.length && lines[i].startsWith('\t')) i++; // consume the "\t<line content>" line
    result[finalLine] = commits[hash];
  }
  return result;
}

ipcMain.handle('git:blame', async (evt, projectRoot, filePath) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const res = await runGit(['blame', '--line-porcelain', '--', filePath], root, { timeoutMs: 15000 });
  if (!res.ok) return { ok: false, error: res.stderr || 'git blame failed.' }; // e.g. untracked/new file — not an error worth surfacing
  return { ok: true, lines: parseBlamePorcelain(res.stdout) };
});

ipcMain.handle('git:diff', async (evt, projectRoot, relPath, staged) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const args = staged ? ['diff', '--cached', '--', relPath] : ['diff', '--', relPath];
  const res = await runGit(args, root);
  if (!res.ok && res.stderr) return { ok: false, error: res.stderr };
  let diff = res.stdout;
  if (!diff && !staged) {
    // likely an untracked file — show its full contents as an "all added" diff
    const untrackedRes = await runGit(['diff', '--no-index', '--', '/dev/null', relPath], root);
    diff = untrackedRes.stdout || '';
  }
  return { ok: true, diff };
});

ipcMain.handle('git:stage', async (evt, projectRoot, relPath) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const res = await runGit(['add', '--', relPath], root);
  return { ok: res.ok, error: res.ok ? null : res.stderr };
});

ipcMain.handle('git:stage-all', async (evt, projectRoot) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const res = await runGit(['add', '-A'], root);
  return { ok: res.ok, error: res.ok ? null : res.stderr };
});

ipcMain.handle('git:unstage', async (evt, projectRoot, relPath) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const res = await runGit(['reset', '--', relPath], root);
  return { ok: res.ok, error: res.ok ? null : res.stderr };
});

ipcMain.handle('git:unstage-all', async (evt, projectRoot) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const res = await runGit(['reset'], root);
  return { ok: res.ok, error: res.ok ? null : res.stderr };
});

ipcMain.handle('git:discard', async (evt, projectRoot, relPath) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const res = await runGit(['checkout', '--', relPath], root);
  return { ok: res.ok, error: res.ok ? null : res.stderr };
});

ipcMain.handle('git:commit', async (evt, projectRoot, message) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  if (!message || !message.trim()) return { ok: false, error: 'Commit message cannot be empty.' };
  const res = await runGit(['commit', '-m', message], root);
  return { ok: res.ok, error: res.ok ? null : (res.stderr || res.stdout) };
});

ipcMain.handle('git:branches', async (evt, projectRoot) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const res = await runGit(['branch', '--list', '--format=%(HEAD)|%(refname:short)'], root);
  if (!res.ok) return { ok: false, error: res.stderr };
  const branches = res.stdout.split('\n').filter(Boolean).map((line) => {
    const [head, name] = line.split('|');
    return { name, current: head === '*' };
  });
  return { ok: true, branches };
});

ipcMain.handle('git:checkout-branch', async (evt, projectRoot, branchName) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const res = await runGit(['checkout', branchName], root);
  return { ok: res.ok, error: res.ok ? null : (res.stderr || res.stdout) };
});

ipcMain.handle('git:create-branch', async (evt, projectRoot, branchName) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const res = await runGit(['checkout', '-b', branchName], root);
  return { ok: res.ok, error: res.ok ? null : (res.stderr || res.stdout) };
});

ipcMain.handle('git:log', async (evt, projectRoot, limit = 50) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const format = '%H%x1f%h%x1f%an%x1f%ar%x1f%s';
  const res = await runGit(['log', `-n${limit}`, `--pretty=format:${format}`], root);
  if (!res.ok) return { ok: false, error: res.stderr || 'No commits yet.' };
  const commits = res.stdout.split('\n').filter(Boolean).map((line) => {
    const [hash, short, author, date, subject] = line.split('\x1f');
    return { hash, short, author, date, subject };
  });
  return { ok: true, commits };
});

ipcMain.handle('git:ignored-paths', async (evt, projectRoot) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, paths: [] };
  // --directory collapses a wholly-ignored folder into one "name/" entry
  // instead of listing every file inside it — exactly what the tree filter
  // needs, and much cheaper than enumerating everything.
  const res = await runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], root);
  if (!res.ok) return { ok: false, paths: [] };
  return { ok: true, root, paths: res.stdout.split('\n').filter(Boolean) };
});

ipcMain.handle('git:show-commit', async (evt, projectRoot, hash) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const res = await runGit(['show', hash], root);
  if (!res.ok) return { ok: false, error: res.stderr || 'Could not load commit.' };
  return { ok: true, diff: res.stdout };
});

ipcMain.handle('git:remote-status', async (evt, projectRoot) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
  if (!upstream.ok) return { ok: true, hasUpstream: false };
  const counts = await runGit(['rev-list', '--left-right', '--count', '@{u}...HEAD'], root);
  if (!counts.ok) return { ok: true, hasUpstream: true, remote: upstream.stdout.trim(), ahead: 0, behind: 0 };
  const [behind, ahead] = counts.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
  return { ok: true, hasUpstream: true, remote: upstream.stdout.trim(), ahead, behind };
});

ipcMain.handle('git:push', async (evt, projectRoot) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const authArgs = await githubAuthArgsForRemote(root);
  const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
  let res;
  if (!upstream.ok) {
    const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    const branch = branchRes.stdout.trim();
    res = await runGit([...authArgs, 'push', '--set-upstream', 'origin', branch], root, { authSensitive: true, timeoutMs: 30000 });
  } else {
    res = await runGit([...authArgs, 'push'], root, { authSensitive: true, timeoutMs: 30000 });
  }
  return { ok: res.ok, error: res.ok ? null : (res.stderr || res.stdout || 'Push failed.') };
});

ipcMain.handle('git:pull', async (evt, projectRoot) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const authArgs = await githubAuthArgsForRemote(root);
  // --no-rebase: always merge on divergent branches rather than letting git
  // fall back to asking for a pull.rebase preference it may not have set —
  // newer git refuses to guess and fails outright without this. Merge is the
  // safer default for a GUI client (no history rewriting to reason about
  // without a terminal open), and matches most other git GUIs' defaults.
  const res = await runGit([...authArgs, 'pull', '--no-rebase'], root, { authSensitive: true, timeoutMs: 30000 });
  return { ok: res.ok, error: res.ok ? null : (res.stderr || res.stdout || 'Pull failed.') };
});

