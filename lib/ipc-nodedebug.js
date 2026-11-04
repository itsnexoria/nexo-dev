'use strict';
// IPC for the Node/TypeScript debugger (CDP). Channels are prefixed `njs:`.
const path = require('path');
const { NodeDebugSession, isNodeDebuggable } = require('./nodedebug');

function register({ ipcMain, getWindow, scope }) {
  let session = null;

  const send = (name, payload) => {
    const w = getWindow && getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('njs:event', name, payload);
  };

  ipcMain.handle('njs:start', async (evt, projectRoot, file, breakpoints) => {
    if (typeof file !== 'string' || !isNodeDebuggable(file)) return { ok: false, error: 'Not a JavaScript or TypeScript file.' };
    if (session) { try { session.stop(); } catch { /* gone */ } session = null; }
    const bps = {};
    for (const [f, lines] of Object.entries(breakpoints || {})) {
      if (!Array.isArray(lines)) continue;
      if (scope && !scope.allows(f)) continue;
      bps[f] = lines.filter((n) => Number.isInteger(n) && n > 0);
    }
    const s = new NodeDebugSession({
      file, cwd: typeof projectRoot === 'string' && projectRoot ? projectRoot : path.dirname(file), breakpoints: bps,
      onEvent: (name, payload) => { if (session === s || name === 'terminated') send(name, payload); },
    });
    session = s;
    try {
      await s.start();
      return { ok: true };
    } catch (err) {
      if (session === s) session = null;
      s.stop();
      return { ok: false, reason: err.code === 'no-ts-runner' ? 'no-ts-runner' : 'error', error: err.message };
    }
  });
  ipcMain.handle('njs:control', async (evt, cmd) => { if (session) { try { await session.control(cmd); } catch { /* ignore */ } } return { ok: true }; });
  ipcMain.handle('njs:stop', () => { if (session) { session.stop(); session = null; } return { ok: true }; });
  ipcMain.handle('njs:write', (evt, text) => { if (session && typeof text === 'string') session.write(text); return { ok: true }; });
  ipcMain.handle('njs:set-breakpoints', async (evt, file, lines) => {
    if (session && Array.isArray(lines)) { try { await session.setBreakpoints(file, lines.filter((n) => Number.isInteger(n) && n > 0)); } catch { /* ignore */ } }
    return { ok: true };
  });
  ipcMain.handle('njs:frame-vars', async (evt, frameId) => {
    if (!session) return { ok: false };
    try { return { ok: true, variables: await session.frameVariables(frameId) }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('njs:eval', async (evt, expr, frameId) => {
    if (!session) return { ok: false, error: 'No active debug session.' };
    try { return { ok: true, result: await session.evaluate(String(expr), frameId) }; } catch (err) { return { ok: false, error: err.message }; }
  });

  // never leave a debuggee behind when the app exits
  process.on('exit', () => { if (session) { try { session.kill(); } catch { /* gone */ } } });
  return { shutdown: async () => { if (session) { session.stop(); session = null; } } };
}
module.exports = { register };
