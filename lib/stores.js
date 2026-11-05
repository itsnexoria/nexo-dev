'use strict';
// JSON-file stores under userData (recent projects/files, preferences, crash-recovery sessions) and their IPC.
const path = require('path');
const fs = require('fs');

function createStores({ app, ipcMain, scope, getDiscord }) {
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
    scope.addRoot(folderPath);
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
  // ---------- Preferences store (simple JSON file) ----------
  // Schema defaults + sanitization live in lib/prefs.js (kept dependency-free
  // from Electron so the validation rules are unit-testable).
  const { DEFAULT_PREFS, sanitizePrefsPartial } = require('./prefs');
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

  ipcMain.handle('prefs:get', () => readPrefs());
  ipcMain.handle('prefs:set', (evt, partial) => {
    const clean = sanitizePrefsPartial(partial || {});
    const merged = { ...readPrefs(), ...clean };
    writePrefs(merged);
    if (clean.discordRpcEnabled !== undefined || clean.discordClientId !== undefined) {
      getDiscord().reconnect();
    }
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
  return { recentFilePath, readRecent, writeRecent, addRecent, recentFilesPath, readRecentFiles, writeRecentFiles, addRecentFile, prefsFilePath, readPrefs, writePrefs, sessionsFilePath, readSessions, writeSessions };
}

module.exports = { createStores };
