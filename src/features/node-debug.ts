
// Node.js / TypeScript debugging over CDP (lib/nodedebug.js). State lives in the shared `dbg` object
// with dbg.kind === 'node'; python.ts routes through dbgApi() so one UI serves both languages.

const NODE_DEBUG_RE = /\.(?:[cm]?js|[cm]?ts|tsx)$/i;
function isNodeDebugPath(p: any) { return NODE_DEBUG_RE.test(p || ''); }
function isDebuggablePath(p: any) { return /\.pyw?$/i.test(p || '') || isNodeDebugPath(p); }

function dbgApi() {
  const n = window.nexo;
  if (dbg && dbg.kind === 'node') {
    return {
      control: (c: any) => n.njsControl(c), stop: () => n.njsStop(), write: (t: any) => n.njsWrite(t),
      setBreakpoints: (f: any, l: any) => n.njsSetBreakpoints(f, l), frameVars: (id: any) => n.njsFrameVars(id), evaluate: (e: any, id: any) => n.njsEval(e, id),
    };
  }
  return {
    control: (c: any) => n.dbgControl(c), stop: () => n.dbgStop(), write: (t: any) => n.dbgWrite(t),
    setBreakpoints: (f: any, l: any) => n.dbgSetBreakpoints(f, l), frameVars: (id: any) => n.dbgFrameVars(id), evaluate: (e: any, id: any) => n.dbgEval(e, id),
  };
}

function nodeDebugStartFailed(t: any, res: any) {
  if (res.reason === 'no-ts-runner') {
    termAppend(t, 'TypeScript debugging needs tsx or ts-node in this project.\n', 'term-err');
    if (confirm('Debugging TypeScript needs a runner (tsx or ts-node) installed in this project.\n\nInstall tsx as a dev dependency now?')) {
      runCommandInTerminal('npm install -D tsx');
      flashToast('Installing tsx — press F5 again when it finishes');
    }
  } else termAppend(t, `[debug error] ${res.error || 'Could not start the Node debugger.'}\n`, 'term-err');
}

window.nexo.onNjsEvent(async (name: any, p: any) => {
  if (!dbg || dbg.kind !== 'node') return;
  const t = dbgTerminal();
  if (name === 'output') { if (t) termAppendAnsi(t, p.output); return; }
  if (name === 'continued') { dbg.stopped = false; setDbgButtons(); refreshAllDebugDecorations(); renderDebugPanel(); return; }
  if (name === 'stopped') {
    dbg.stopped = true; dbg.frames = p.frames || []; dbg.variables = p.variables || []; dbg.selFrame = 0; dbg.evalOut = '';
    setDbgButtons();
    await showDebugFrame(0);
    return;
  }
  if (name === 'terminated') endDebugUi(t, p.code);
});
