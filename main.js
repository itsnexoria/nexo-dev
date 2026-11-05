const { app, BrowserWindow, Menu, dialog, ipcMain, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { Scope, installGuard } = require('./lib/scope');
const workspaceLib = require('./lib/workspace');
const { isSafeName, isSafeExternalUrl } = require('./lib/validate');

// ---------- Filesystem scope + IPC guard ----------
// The renderer may only touch folders the main process saw the user choose (see lib/scope.js).
const scope = new Scope({ readOnlyRoots: [path.join(__dirname, 'node_modules')] });
if (process.env.NEXO_E2E) scope.addRoot(require('os').tmpdir()); // e2e tests create projects in the temp dir
function grantPath(p) {
  try {
    if (typeof p !== 'string' || !p) return;
    if (fs.statSync(p).isDirectory()) scope.addRoot(p); else scope.addRoot(path.dirname(p));
  } catch { /* nonexistent: nothing to grant */ }
}
installGuard(ipcMain, {
  scope,
  isTrustedSender: (evt) => !!mainWindow && !mainWindow.isDestroyed() && evt.sender === mainWindow.webContents
    && /^file:\/\//i.test(evt.senderFrame ? evt.senderFrame.url : ''),
});
ipcMain.handle('scope:grant-drop', (evt, paths) => { (Array.isArray(paths) ? paths.slice(0, 50) : []).forEach(grantPath); return { ok: true }; });

// Safety net: log anything that slips through try/catch instead of letting
// the process die silently or dump a raw stack to a terminal the user isn't
// looking at. We still let Electron's default crash-reporter/dialog behavior
// happen for uncaughtException — this only guarantees it gets logged first.
function logCrash(kind, err) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'main.log');
    try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.old'); } catch { /* no log yet */ }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${kind}: ${err && err.stack ? err.stack : String(err)}\n`);
  } catch { /* logging must never throw */ }
}
process.on('uncaughtException', (err) => { console.error('[uncaught exception]', err); logCrash('uncaughtException', err); });
process.on('unhandledRejection', (err) => { console.error('[unhandled rejection]', err); logCrash('unhandledRejection', err); });
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled rejection]', reason);
});

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
    if (p) { grantPath(p); mainWindow.webContents.send('open-path', p); }
  }
});

// ---------- Global text search across project files ----------
// Walkers, constants, and replace-regex building all live in lib/search.js
// (kept dependency-free from Electron so they're unit-testable).
const {
  SEARCH_MAX_MATCHES,
  SEARCH_MAX_FILES_WITH_MATCHES,
  QUICK_OPEN_MAX_FILES,
  buildReplaceRegExp,
  walkForSearch,
  walkForReplace,
  walkForFileList,
} = require('./lib/search');

require('./lib/ipc-git').register({ ipcMain, app, safeStorage, addRecent: (...a) => addRecent(...a) });

const { readRecent, writeRecent, addRecent, readPrefs } = require('./lib/stores').createStores({ app, ipcMain, scope, getDiscord: () => discord });

// ---------- Discord Rich Presence ----------
// Uses @xhayper/discord-rpc, a pure-JS client with no native build step —
// it talks to the local Discord desktop app over its IPC pipe/socket, so
// there's nothing to install beyond having Discord open. Fully optional:
// off by default, and only ever connects once the user turns it on and
// supplies their own Discord Application Client ID in Settings (create one
// free at https://discord.com/developers/applications — Rich Presence
// can't work without an app ID registered there).
const discord = require('./lib/discord').createDiscord({ ipcMain, readPrefs });

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
    webPreferences: { contextIsolation: true, sandbox: true },
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
    // The app draws its own branded menu bar in the renderer (see
    // #app-menu in index.html) instead of using the OS's plain default
    // menu strip. autoHideMenuBar keeps the native one out of the way
    // during normal use — all its accelerators (Ctrl+S etc.) still work
    // via buildMenu() below — while leaving Alt as a fallback to reveal
    // it, in case the custom menu ever needs bypassing for debugging.
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.webContents.on('render-process-gone', (e, details) => logCrash('render-process-gone', JSON.stringify(details)));
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // The renderer must never navigate away or spawn windows: external links go
  // through the validated shell:open-external handler only.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (isSafeExternalUrl(url)) shell.openExternal(url); }
  });
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

function showAboutDialog() {
  if (!mainWindow) return;
  return dialog.showMessageBox(mainWindow, {
    title: 'Nexo Dev',
    message: 'Nexo Dev',
    detail: 'A lightweight code editor and project manager.\nBuilt for the Nexo network.',
  });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', registerAccelerator: false, click: () => mainWindow.webContents.send('menu:open-folder') },
        { label: 'New File', accelerator: 'CmdOrCtrl+N', registerAccelerator: false, click: () => mainWindow.webContents.send('menu:new-file') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', registerAccelerator: false, click: () => mainWindow.webContents.send('menu:save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', registerAccelerator: false, click: () => mainWindow.webContents.send('menu:save-as') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' },
        { label: 'Find in Files', accelerator: 'CmdOrCtrl+Shift+F', registerAccelerator: false, click: () => mainWindow.webContents.send('menu:show-search') },
        { label: 'Source Control', accelerator: 'CmdOrCtrl+Shift+G', registerAccelerator: false, click: () => mainWindow.webContents.send('menu:show-git') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', registerAccelerator: false, click: () => mainWindow.webContents.send('menu:toggle-sidebar') },
        { label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+`', registerAccelerator: false, click: () => mainWindow.webContents.send('menu:toggle-terminal') },
        { label: 'Toggle Split Editor', accelerator: 'CmdOrCtrl+\\', registerAccelerator: false, click: () => mainWindow.webContents.send('menu:toggle-split') },
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
        { label: 'About Nexo Dev', click: () => showAboutDialog() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// These back the custom menu bar drawn in the renderer (#app-menu) for the
// handful of actions that can only happen in the main process — everything
// else the custom menu needs (save, open folder, toggle terminal, etc.) is
// already a plain renderer-side function it can call directly.
ipcMain.handle('app:quit', () => app.quit());
ipcMain.handle('app:reload', () => { if (mainWindow) mainWindow.webContents.reload(); });
ipcMain.handle('app:toggle-devtools', () => { if (mainWindow) mainWindow.webContents.toggleDevTools(); });
ipcMain.handle('app:toggle-fullscreen', () => { if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); });
ipcMain.handle('app:show-about', () => showAboutDialog());

const updater = require('./lib/updater').createUpdater({ ipcMain, app, getWindow: () => mainWindow });

app.whenReady().then(() => {
  createSplash();
  createWindow();
  const initialPath = extractPathFromArgv(process.argv);
  if (initialPath) { pendingOpenPath = initialPath; grantPath(initialPath); }
  for (const r of readRecent()) scope.addRoot(r);

  updater.checkSoon();

  discord.connect();
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

// Terminals run with the project's selected Python venv "activated"
// (VIRTUAL_ENV + its bin dir first on PATH), so python/pip just work.
function pythonEnvFor(cwd) {
  const env = { ...process.env, PYTHONUNBUFFERED: '1' };
  try {
    const dir = pythonIpc.resolveVenvDir(cwd);
    if (!dir) return env;
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    env.VIRTUAL_ENV = path.join(cwd, dir);
    env[pathKey] = pythonIpc.venvBinDir(cwd, dir) + path.delimiter + (env[pathKey] || '');
    delete env.PYTHONHOME;
  } catch { /* fall back to plain env */ }
  return env;
}

ipcMain.handle('term:run', (evt, cwd, command) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const isWin = process.platform === 'win32';
  const customShell = readPrefs().customShell;
  const shell = customShell || (isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh'));
  const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

  let child;
  try {
    child = spawn(shell, args, { cwd, windowsHide: true, env: pythonEnvFor(cwd) });
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

ipcMain.handle('term:write', (evt, id, text) => {
  const child = runningProcs.get(id);
  if (!child || !child.stdin || child.stdin.destroyed) return { ok: false };
  try { child.stdin.write(text); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
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

// ---------- Interactive PTY terminals (xterm.js front-end) ----------
const { PtyManager } = require('./lib/pty');
const ptyManager = new PtyManager({
  onData: (id, data) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:data', id, data); },
  onExit: (id, code) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:exit', id, code); },
});
ipcMain.handle('pty:available', () => ({ available: ptyManager.available, error: ptyManager.error }));
ipcMain.handle('pty:spawn', (evt, opts = {}) => {
  try {
    const cwd = typeof opts.cwd === 'string' ? opts.cwd : undefined;
    let command;
    if (opts.remote) {
      if (opts.remote.kind === 'devcontainer' && !scope.allows(opts.remote.folder)) return { ok: false, error: 'That folder is outside the open workspace.' };
      command = require('./lib/remote').build(opts.remote);
      const exe = require('./lib/lsp').findExecutable(command.file, null);
      if (!exe) return { ok: false, error: `"${command.file}" was not found on PATH.` };
      command = { ...command, file: exe };
    }
    return { ok: true, ...ptyManager.spawn({ cwd, cols: opts.cols, rows: opts.rows, env: pythonEnvFor(cwd || process.cwd()), shell: readPrefs().customShell, command }) };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('remote:ssh-hosts', () => {
  try { return { ok: true, hosts: require('./lib/remote').parseSshHosts(fs.readFileSync(path.join(require('os').homedir(), '.ssh', 'config'), 'utf8')) }; } catch { return { ok: true, hosts: [] }; }
});
ipcMain.handle('remote:docker-list', () => new Promise((resolve) => {
  const docker = require('./lib/lsp').findExecutable('docker', null);
  if (!docker) return resolve({ ok: false, error: 'docker was not found on PATH.', names: [] });
  execFile(docker, ['ps', '--format', '{{.Names}}'], { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? { ok: false, error: 'Could not list containers (is Docker running?).', names: [] } : { ok: true, names: require('./lib/remote').parseDockerNames(stdout) }));
}));
ipcMain.handle('pty:write', (evt, id, data) => ({ ok: ptyManager.write(id, data) }));
ipcMain.handle('pty:resize', (evt, id, cols, rows) => { ptyManager.resize(id, cols, rows); return { ok: true }; });
ipcMain.handle('pty:kill', (evt, id) => { ptyManager.kill(id); return { ok: true }; });

// ---------- Language servers (LSP) ----------
const { LspManager } = require('./lib/lsp');
const lspManager = new LspManager({
  getUserServers: () => readPrefs().lspServers || {},
  extraBinDirs: () => [require('./lib/lsp-install').binDir(lspInstallDir())],
  onMessage: (id, msg) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lsp:message', id, msg); },
  onExit: (id, code, error) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lsp:exit', id, code, error); },
});
ipcMain.handle('lsp:start', (evt, lang, root) => {
  if (readPrefs().lspEnabled === false) return { ok: false, error: 'Language servers are disabled in Settings.', code: 'disabled' };
  if (typeof lang !== 'string' || typeof root !== 'string' || !fs.existsSync(root)) return { ok: false, error: 'Bad request.' };
  return lspManager.start(lang, root);
});
const extDir = () => path.join(app.getPath('userData'), 'extensions');
const extStatePath = () => path.join(app.getPath('userData'), 'extensions-state.json');
const readExtDisabled = () => { try { const d = JSON.parse(fs.readFileSync(extStatePath(), 'utf8')).disabled; return Array.isArray(d) ? d.filter((x) => typeof x === 'string') : []; } catch { return []; } };
ipcMain.handle('ext:list', () => { fs.mkdirSync(extDir(), { recursive: true }); return require('./lib/extensions').scan(extDir(), readExtDisabled()).map(({ dir, ...rest }) => rest); });
ipcMain.handle('ext:set-enabled', (evt, id, enabled) => {
  if (typeof id !== 'string' || !require('./lib/extensions').ID_RE.test(id)) return { ok: false };
  const set = new Set(readExtDisabled()); if (enabled) set.delete(id); else set.add(id);
  fs.writeFileSync(extStatePath(), JSON.stringify({ disabled: [...set] })); return { ok: true };
});
ipcMain.handle('ext:open-folder', () => { fs.mkdirSync(extDir(), { recursive: true }); shell.openPath(extDir()); return { ok: true, dir: extDir() }; });
ipcMain.handle('lsp:status', (evt, root) => {
  const { installCommand, managedPackages } = require('./lib/lsp-servers');
  if (typeof root !== 'string') return { ok: false };
  return { ok: true, rows: lspManager.statusAll(root).map((r) => ({ ...r, installCmd: installCommand(r), canInstall: !!managedPackages(r), installId: r.candidates && r.candidates[0] ? r.candidates[0].id : null })) };
});
const lspInstallDir = () => path.join(app.getPath('userData'), 'lsp-servers');
ipcMain.handle('lsp:install', (evt, id) => {
  if (typeof id !== 'string') return { ok: false, error: 'Bad request.' };
  fs.mkdirSync(lspInstallDir(), { recursive: true });
  const { findExecutable } = require('./lib/lsp');
  return require('./lib/lsp-install').install(id, { dir: lspInstallDir(), find: (c) => findExecutable(c, null), spawn });
});
ipcMain.handle('lsp:send', (evt, id, msg) => ({ ok: lspManager.send(id, msg) }));
ipcMain.handle('lsp:stop', (evt, id) => { lspManager.stop(id); return { ok: true }; });

app.on('before-quit', () => {
  lspManager.stopAll();
  ptyManager.killAll();
  pythonIpc.shutdown();
  for (const child of runningProcs.values()) {
    try { child.kill(); } catch { /* already gone */ }
  }
  for (const watcher of fileWatchers.values()) {
    try { watcher.close(); } catch { /* already gone */ }
  }
  discord.destroy();
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
  scope.addRoot(result.filePaths[0]);
  return result.filePaths[0];
});

ipcMain.handle('dialog:pick-file', async (evt, title, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: title || 'Choose a file',
    filters: Array.isArray(filters) ? filters.slice(0, 5).map((f) => ({ name: String(f.name || ''), extensions: (f.extensions || []).map(String) })) : undefined,
  });
  if (result.canceled || !result.filePaths.length) return null;
  const file = result.filePaths[0];
  scope.addFile(file);
  if (file.endsWith(workspaceLib.WS_EXT)) {
    try { workspaceLib.parse(file, fs.readFileSync(file, 'utf-8')).forEach((r) => scope.addRoot(r)); } catch { /* renderer reports the parse error */ }
  }
  return file;
});


ipcMain.handle('dialog:save-as', async (evt, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName });
  if (result.canceled || !result.filePath) return null;
  scope.addFile(result.filePath);
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

const MAX_READ_BYTES = 50 * 1024 * 1024;
ipcMain.handle('fs:read-file', async (evt, filePath) => {
  try {
    const size = fs.statSync(filePath).size;
    if (size > MAX_READ_BYTES) return { ok: false, code: 'ETOOBIG', error: `File is too large to open (${(size / 1048576).toFixed(1)} MB; limit ${MAX_READ_BYTES / 1048576} MB).` };
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
    if (!isSafeName(name)) return { ok: false, error: 'Invalid file name.' };
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
    if (!isSafeName(name)) return { ok: false, error: 'Invalid folder name.' };
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
    // Try the OS trash/recycle bin first so deletes are recoverable — this is
    // what shell.trashItem is for. It can fail (no trash service on some
    // Linux setups, permissions, etc.), in which case we fall back to a hard
    // delete rather than silently doing nothing, but we tell the caller which
    // one actually happened so the UI can be honest about it.
    await shell.trashItem(targetPath);
    return { ok: true, trashed: true };
  } catch (trashErr) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return { ok: true, trashed: false };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
});

ipcMain.handle('fs:rename', async (evt, oldPath, newName) => {
  try {
    if (!isSafeName(newName)) return { ok: false, error: 'Invalid name.' };
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

// ---------- .editorconfig support ----------
// Parsing/resolution logic lives in lib/editorconfig.js (kept dependency-free
// from Electron so it can be unit-tested with plain Node).
const { resolveEditorConfigProps } = require('./lib/editorconfig');

ipcMain.handle('editorconfig:resolve', async (evt, projectRoot, filePath) => {
  try {
    return { ok: true, props: resolveEditorConfigProps(projectRoot, filePath) };
  } catch (err) {
    return { ok: false, error: err.message, props: {} };
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

// ---------- IPC: live server / HTTP client / DB viewer ----------
const toolsIpc = require('./lib/ipc-tools').register({ ipcMain, dialog, shell, getWindow: () => mainWindow, scope, httpStorePath: path.join(app.getPath('userData'), 'http-client.json') });
app.on('before-quit', () => { toolsIpc.shutdown().catch(() => {}); });
require('./lib/ipc-git-extra').register({ ipcMain });
const dbIpc = require('./lib/ipc-db').register({
  ipcMain, dialog, getWindow: () => mainWindow, scope,
  storePath: path.join(app.getPath('userData'), 'db-connections.json'),
  secrets: {
    encrypt: (s) => { if (!safeStorage.isEncryptionAvailable()) throw new Error('OS keychain encryption is not available; cannot store a password.'); return safeStorage.encryptString(s).toString('base64'); },
    decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
  },
});
app.on('before-quit', () => { dbIpc.shutdown().catch(() => {}); });

const njsIpc = require('./lib/ipc-nodedebug').register({ ipcMain, getWindow: () => mainWindow, scope });
app.on('before-quit', () => { njsIpc.shutdown().catch(() => {}); });

// ---------- IPC: shell ----------
ipcMain.handle('shell:open-external', (evt, url) => {
  if (!isSafeExternalUrl(url)) return { ok: false, error: 'Blocked: only http(s) and mailto links can be opened.' };
  return shell.openExternal(String(url));
});

// ---------- IPC: global search ----------
ipcMain.handle('todos:scan', async (evt, projectRoot) => {
  if (!projectRoot) return { ok: false, error: 'No project open.' };
  const results = { matches: [], matchedFiles: 0 };
  const pattern = '\\b(TODO|FIXME|HACK)\\b:?\\s*(.*)';
  await walkForSearch(projectRoot, pattern, false, results, true);
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
  await walkForSearch(rootPath, query, !!opts.caseSensitive, results, !!opts.useRegex);
  return {
    matches: results.matches,
    truncated: results.matchedFiles >= SEARCH_MAX_FILES_WITH_MATCHES || results.matches.length >= SEARCH_MAX_MATCHES,
  };
});

ipcMain.handle('search:replace-all', async (evt, rootPath, query, replacement, opts = {}) => {
  if (!query) return { filesChanged: 0, totalReplacements: 0, changedPaths: [], errors: [] };
  let re;
  let safeReplacement;
  try {
    ({ re, safeReplacement } = buildReplaceRegExp(query, replacement, opts));
  } catch (err) {
    return { filesChanged: 0, totalReplacements: 0, changedPaths: [], errors: [{ path: '', error: `Invalid regex: ${err.message}` }] };
  }
  const results = { filesChanged: 0, totalReplacements: 0, changedPaths: [], errors: [] };
  await walkForReplace(rootPath, re, safeReplacement, results, (full) => recentWrites.set(full, Date.now()));
  return results;
});

ipcMain.handle('fs:list-files', async (evt, rootPath) => {
  const out = [];
  await walkForFileList(rootPath, out);
  return { files: out, truncated: out.length >= QUICK_OPEN_MAX_FILES };
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

// npm outdated hits the registry over the network to compare against
// "latest", so it's genuinely slow — cache the result per project for a
// short while instead of re-running it every time. An explicit refresh
// click from the UI passes forceRefresh to bypass this.
const OUTDATED_CACHE_TTL_MS = 60 * 1000;
const outdatedCache = new Map(); // projectRoot -> { result, timestamp }

ipcMain.handle('npm:outdated', async (evt, projectRoot, forceRefresh = false) => {
  if (!projectRoot) return { ok: false, error: 'No project open.' };
  if (!fs.existsSync(path.join(projectRoot, 'package.json'))) return { ok: false, reason: 'no-package-json' };
  if (!forceRefresh) {
    const cached = outdatedCache.get(projectRoot);
    if (cached && Date.now() - cached.timestamp < OUTDATED_CACHE_TTL_MS) return cached.result;
  }
  const result = await new Promise((resolve) => {
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
  if (result.ok) outdatedCache.set(projectRoot, { result, timestamp: Date.now() });
  return result;
});

const pythonIpc = require('./lib/ipc-python').register({ ipcMain, getWindow: () => mainWindow, pythonEnvFor, findLocalEslintBin, OUTDATED_CACHE_TTL_MS });

