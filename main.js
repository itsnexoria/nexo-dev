const { app, BrowserWindow, Menu, dialog, ipcMain, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { execFile, spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

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

// ---------- HTTP fetch helper (no external deps, used for site monitoring + SEO audits) ----------
function fetchUrl(targetUrl, { method = 'GET', timeoutMs = 12000, maxRedirects = 4 } = {}) {
  return new Promise((resolve) => {
    const attempt = (u, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(u);
      } catch {
        return resolve({ ok: false, error: 'Invalid URL' });
      }
      const lib = parsed.protocol === 'https:' ? https : http;
      const start = Date.now();
      let settled = false;

      const req = lib.request(
        parsed,
        {
          method,
          timeout: timeoutMs,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; NexoDevMonitor/1.0; +https://nexorealm.org)',
            Accept: 'text/html,application/xhtml+xml,*/*',
          },
        },
        (res) => {
          const chunks = [];
          let total = 0;
          res.on('data', (c) => {
            total += c.length;
            if (total < 3_000_000) chunks.push(c);
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            const ms = Date.now() - start;
            const status = res.statusCode;
            if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
              const nextUrl = new URL(res.headers.location, parsed).toString();
              return attempt(nextUrl, redirectsLeft - 1);
            }
            resolve({
              ok: status >= 200 && status < 400,
              status,
              ms,
              finalUrl: parsed.toString(),
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf-8'),
            });
          });
        }
      );
      req.on('timeout', () => {
        if (settled) return;
        settled = true;
        req.destroy();
        resolve({ ok: false, error: 'Request timed out', ms: timeoutMs });
      });
      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: err.message, ms: Date.now() - start });
      });
      req.end();
    };
    attempt(targetUrl, maxRedirects);
  });
}

// ---------- Lightweight regex-based HTML analysis for SEO audits ----------
function extractMetaContent(html, name) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (new RegExp(`name=["']${name}["']`, 'i').test(tag)) {
      const m = tag.match(/content=["']([^"']*)["']/i);
      if (m) return m[1];
    }
  }
  return null;
}

function extractCanonical(html) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (/rel=["']canonical["']/i.test(tag)) {
      const m = tag.match(/href=["']([^"']*)["']/i);
      if (m) return m[1];
    }
  }
  return null;
}

function analyzeImages(html) {
  const tags = html.match(/<img\b[^>]*>/gi) || [];
  let missingAlt = 0;
  for (const tag of tags) {
    const m = tag.match(/alt=["']([^"']*)["']/i);
    if (!m || !m[1].trim()) missingAlt++;
  }
  return { total: tags.length, missingAlt };
}

async function runSeoAudit(siteUrl) {
  const pageRes = await fetchUrl(siteUrl, { method: 'GET' });
  if (!pageRes.ok) {
    return { ok: false, error: pageRes.error || `Page returned status ${pageRes.status}`, auditedAt: Date.now() };
  }

  const html = pageRes.body || '';
  const origin = new URL(pageRes.finalUrl).origin;
  const breakdown = [];
  let score = 0;

  const add = (key, label, points, max, detail) => {
    breakdown.push({ key, label, pass: points >= max * 0.7, points, max, detail });
    score += points;
  };

  // Title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
  if (!title) add('title', 'Title tag', 0, 10, 'No <title> tag found.');
  else if (title.length < 10) add('title', 'Title tag', 4, 10, `Title is very short (${title.length} chars): "${title}"`);
  else if (title.length > 65) add('title', 'Title tag', 5, 10, `Title may get truncated in search results (${title.length} chars): "${title}"`);
  else add('title', 'Title tag', 10, 10, `"${title}" — ${title.length} chars, good length.`);

  // Meta description
  const desc = extractMetaContent(html, 'description');
  if (!desc) add('description', 'Meta description', 0, 10, 'No meta description found.');
  else if (desc.length < 50) add('description', 'Meta description', 5, 10, `Description is short (${desc.length} chars).`);
  else if (desc.length > 160) add('description', 'Meta description', 6, 10, `Description may get truncated (${desc.length} chars).`);
  else add('description', 'Meta description', 10, 10, `${desc.length} chars — good length.`);

  // H1
  const h1s = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi) || [];
  if (h1s.length === 0) add('h1', 'H1 heading', 0, 10, 'No H1 tag found.');
  else if (h1s.length === 1) add('h1', 'H1 heading', 10, 10, 'Exactly one H1 tag — ideal.');
  else add('h1', 'H1 heading', 5, 10, `${h1s.length} H1 tags found — should usually be exactly one.`);

  // Image alt coverage
  const imgs = analyzeImages(html);
  if (imgs.total === 0) add('images', 'Image alt text', 10, 10, 'No images on the page.');
  else {
    const covered = imgs.total - imgs.missingAlt;
    const pts = Math.round((covered / imgs.total) * 10);
    add('images', 'Image alt text', pts, 10, `${covered}/${imgs.total} images have alt text.`);
  }

  // Canonical
  const canonical = extractCanonical(html);
  if (canonical) add('canonical', 'Canonical tag', 10, 10, `Points to ${canonical}`);
  else add('canonical', 'Canonical tag', 0, 10, 'No canonical link tag found.');

  // Viewport
  const viewport = extractMetaContent(html, 'viewport');
  if (viewport) add('viewport', 'Mobile viewport tag', 10, 10, 'Viewport meta tag present.');
  else add('viewport', 'Mobile viewport tag', 0, 10, 'No viewport meta tag — page may not be mobile-friendly.');

  // HTTPS
  if (origin.startsWith('https://')) add('https', 'HTTPS', 10, 10, 'Site is served over HTTPS.');
  else add('https', 'HTTPS', 0, 10, 'Site is not served over HTTPS.');

  // robots.txt
  const robots = await fetchUrl(`${origin}/robots.txt`, { method: 'GET', timeoutMs: 8000 });
  if (robots.ok) add('robots', 'robots.txt', 10, 10, 'Found and reachable.');
  else add('robots', 'robots.txt', 0, 10, 'Not found at /robots.txt.');

  // sitemap.xml
  const sitemap = await fetchUrl(`${origin}/sitemap.xml`, { method: 'GET', timeoutMs: 8000 });
  if (sitemap.ok) add('sitemap', 'sitemap.xml', 10, 10, 'Found and reachable.');
  else add('sitemap', 'sitemap.xml', 0, 10, 'Not found at /sitemap.xml.');

  // Response time
  if (pageRes.ms <= 1500) add('speed', 'Response time', 10, 10, `${pageRes.ms}ms — fast.`);
  else if (pageRes.ms <= 3500) add('speed', 'Response time', 5, 10, `${pageRes.ms}ms — could be faster.`);
  else add('speed', 'Response time', 0, 10, `${pageRes.ms}ms — slow.`);

  return { ok: true, score, breakdown, finalUrl: pageRes.finalUrl, auditedAt: Date.now() };
}

// ---------- Monitored sites store ----------
const sitesFilePath = () => path.join(app.getPath('userData'), 'monitored-sites.json');

function readSites() {
  try {
    return JSON.parse(fs.readFileSync(sitesFilePath(), 'utf-8'));
  } catch {
    return [];
  }
}
function writeSites(list) {
  try {
    fs.writeFileSync(sitesFilePath(), JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write sites:', err);
  }
}
function normalizeUrl(input) {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

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

function walkForSearch(root, query, caseSensitive, results, budget) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.matchedFiles >= SEARCH_MAX_FILES_WITH_MATCHES || results.matches.length >= SEARCH_MAX_MATCHES) return;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SEARCH_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walkForSearch(full, query, caseSensitive, results, budget);
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

    const haystack = caseSensitive ? content : content.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    if (!haystack.includes(needle)) continue;

    const lines = content.split(/\r\n|\r|\n/);
    const fileMatches = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hLine = caseSensitive ? line : line.toLowerCase();
      let idx = hLine.indexOf(needle);
      while (idx !== -1) {
        fileMatches.push({ line: i + 1, col: idx + 1, preview: line.trim().slice(0, 200) });
        if (fileMatches.length >= 30) break; // cap matches per file
        idx = hLine.indexOf(needle, idx + needle.length);
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
    execFile('git', args, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      timeout: opts.timeoutMs || 0, // 0 = no timeout (used for push/pull below)
      // No tty is attached to this process, so an interactive credential
      // prompt would just hang forever. Fail fast with a clear error instead.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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

// ---------- Preferences store (all user settings) ----------
const DEFAULT_PREFS = {
  theme: 'dark',
  fontSize: 13.5,
  minimap: true,
  wordWrap: false,
  autoSave: false,
  autoSaveDelayMs: 1000,
  defaultSiteInterval: 10,
  customShell: '',
  customTheme: { bg: '#0c0c10', text: '#ececf0', accent: '#ff3b30' },
  customThemes: [], // saved named presets: [{ id, name, bg, text, accent }]
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
  if (partial.autoSave !== undefined) clean.autoSave = !!partial.autoSave;
  if (partial.autoSaveDelayMs !== undefined) {
    clean.autoSaveDelayMs = Math.max(200, Math.min(10000, Number(partial.autoSaveDelayMs) || 1000));
  }
  if (partial.defaultSiteInterval !== undefined) {
    clean.defaultSiteInterval = Math.max(1, Math.min(1440, Number(partial.defaultSiteInterval) || 10));
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
  return clean;
}

ipcMain.handle('prefs:get', () => readPrefs());
ipcMain.handle('prefs:set', (evt, partial) => {
  const merged = { ...readPrefs(), ...sanitizePrefsPartial(partial || {}) };
  writePrefs(merged);
  return merged;
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
  startMonitorScheduler();
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
ipcMain.handle('search:text', async (evt, rootPath, query, opts = {}) => {
  if (!query || !query.trim()) return { matches: [], truncated: false };
  const results = { matches: [], matchedFiles: 0 };
  walkForSearch(rootPath, query, !!opts.caseSensitive, results, {});
  return {
    matches: results.matches,
    truncated: results.matchedFiles >= SEARCH_MAX_FILES_WITH_MATCHES || results.matches.length >= SEARCH_MAX_MATCHES,
  };
});

// ---------- IPC: git ----------
ipcMain.handle('git:status', async (evt, projectRoot) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const res = await runGit(['status', '--porcelain'], root);
  if (!res.ok) return { ok: false, error: res.stderr || 'git status failed.' };
  const { staged, unstaged, conflicts } = parsePorcelainStatus(res.stdout);
  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  return { ok: true, root, branch: branchRes.ok ? branchRes.stdout.trim() : '', staged, unstaged, conflicts };
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

ipcMain.handle('git:unstage', async (evt, projectRoot, relPath) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const res = await runGit(['reset', '--', relPath], root);
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
  const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
  let res;
  if (!upstream.ok) {
    const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    const branch = branchRes.stdout.trim();
    res = await runGit(['push', '--set-upstream', 'origin', branch], root, { timeoutMs: 30000 });
  } else {
    res = await runGit(['push'], root, { timeoutMs: 30000 });
  }
  return { ok: res.ok, error: res.ok ? null : (res.stderr || res.stdout || 'Push failed.') };
});

ipcMain.handle('git:pull', async (evt, projectRoot) => {
  const root = await getGitRoot(projectRoot);
  if (!root) return { ok: false, error: 'Not a git repository.' };
  const res = await runGit(['pull'], root, { timeoutMs: 30000 });
  return { ok: res.ok, error: res.ok ? null : (res.stderr || res.stdout || 'Pull failed.') };
});

// ---------- IPC: monitored sites ----------
ipcMain.handle('sites:get', () => readSites());

ipcMain.handle('sites:add', (evt, rawUrl, name) => {
  const url = normalizeUrl(rawUrl);
  const list = readSites();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const site = {
    id,
    url,
    name: name && name.trim() ? name.trim() : new URL(url).hostname,
    addedAt: Date.now(),
    lastCheck: null,
    lastAudit: null,
    intervalMinutes: readPrefs().defaultSiteInterval,
    history: [],
    auditHistory: [],
  };
  list.unshift(site);
  writeSites(list);
  return list;
});

ipcMain.handle('sites:remove', (evt, id) => {
  const list = readSites().filter((s) => s.id !== id);
  writeSites(list);
  return list;
});

const HISTORY_CAP = 50;
const AUDIT_HISTORY_CAP = 30;

async function checkSiteById(id, list) {
  const site = list.find((s) => s.id === id);
  if (!site) return null;
  const result = await fetchUrl(site.url, { method: 'GET', timeoutMs: 12000 });
  const wasOk = site.lastCheck ? site.lastCheck.ok : null;
  site.lastCheck = {
    ok: result.ok,
    status: result.status || null,
    ms: result.ms || null,
    error: result.error || null,
    checkedAt: Date.now(),
  };
  if (!site.history) site.history = [];
  site.history.push({ ts: site.lastCheck.checkedAt, ok: result.ok, status: result.status || null, ms: result.ms || null });
  if (site.history.length > HISTORY_CAP) site.history = site.history.slice(-HISTORY_CAP);
  return { site, statusChanged: wasOk !== null && wasOk !== result.ok };
}

ipcMain.handle('sites:check', async (evt, id) => {
  const list = readSites();
  const res = await checkSiteById(id, list);
  if (!res) return null;
  writeSites(list);
  return res.site;
});

ipcMain.handle('sites:audit', async (evt, id) => {
  const list = readSites();
  const site = list.find((s) => s.id === id);
  if (!site) return null;
  const report = await runSeoAudit(site.url);
  site.lastAudit = report;
  if (report.ok) {
    if (!site.auditHistory) site.auditHistory = [];
    site.auditHistory.push({ ts: report.auditedAt, score: report.score });
    if (site.auditHistory.length > AUDIT_HISTORY_CAP) site.auditHistory = site.auditHistory.slice(-AUDIT_HISTORY_CAP);
  }
  writeSites(list);
  return site;
});

ipcMain.handle('sites:set-interval', (evt, id, minutes) => {
  const list = readSites();
  const site = list.find((s) => s.id === id);
  if (!site) return list;
  site.intervalMinutes = Math.max(1, Math.min(1440, Number(minutes) || 10));
  writeSites(list);
  return list;
});

// ---------- Background monitoring scheduler ----------
// Runs while the app is open (any window) and checks each site on its own
// interval, independent of which workspace/tab is focused. Fires a native
// notification when a site's up/down status flips.
let schedulerTimer = null;
function startMonitorScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(async () => {
    const list = readSites();
    if (!list.length) return;
    const now = Date.now();
    let changed = false;
    for (const site of list) {
      const dueAt = site.lastCheck ? site.lastCheck.checkedAt + (site.intervalMinutes || 10) * 60000 : 0;
      if (now < dueAt) continue;
      const res = await checkSiteById(site.id, list);
      if (!res) continue;
      changed = true;
      if (res.statusChanged && Notification.isSupported()) {
        const n = new Notification({
          title: res.site.lastCheck.ok ? `${res.site.name} is back up` : `${res.site.name} is down`,
          body: res.site.lastCheck.ok
            ? `Responded with status ${res.site.lastCheck.status} in ${res.site.lastCheck.ms}ms.`
            : (res.site.lastCheck.error || `Status ${res.site.lastCheck.status}`),
          icon: APP_ICON,
        });
        n.show();
      }
    }
    if (changed) {
      writeSites(list);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sites:updated', list);
    }
  }, 30_000); // check which sites are due every 30s
}
