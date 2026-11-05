'use strict';
const { autoUpdater } = require('electron-updater');

function createUpdater({ ipcMain, app, getWindow }) {
  // ---------- Auto-update (GitHub Releases via electron-updater) ----------
  // Downloads only happen when the user explicitly agrees — never silently in
  // the background, since that could interrupt someone mid-work with a forced
  // restart later. The renderer drives the UI; this just relays events.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  let manualUpdateCheck = false;

  function sendToRenderer(channel, ...args) {
    if (getWindow() && !getWindow().isDestroyed()) getWindow().webContents.send(channel, ...args);
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
  // Check once, a bit after launch (not immediately) so it doesn't compete with startup work.
  function checkSoon(ms = 8000) { if (app.isPackaged) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), ms); }
  return { checkSoon };
}

module.exports = { createUpdater };
