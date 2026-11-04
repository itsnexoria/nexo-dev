
// Language Server Protocol client: bridges stdio language servers (spawned by the
// main process) to Monaco providers. Servers are optional; if one isn't installed
// the editor keeps working with Monaco's built-in features.
'use strict';
(function () {
  const LSP_LANGS = new Set(['python', 'go', 'rust', 'c', 'cpp', 'java', 'php', 'ruby', 'shell', 'yaml', 'typescript', 'javascript']);
  const SERVER_KEY = { javascript: 'typescript' }; // JS and TS share one tsserver-backed process
  const clients = new Map();  // `${serverKey}|${root}` -> client
  const byId = new Map();     // process id -> client
  const warned = new Set();
  const registered = new Set(); // monaco languages with providers registered
  const sleep = (ms: any) => new Promise((r) => setTimeout(r, ms));
  const statusEl = document.createElement('span');
  statusEl.id = 'status-lsp'; statusEl.className = 'hidden';
  document.getElementById('status-right')!.prepend(statusEl);

  const toUri = (p: any) => monaco.Uri.file(p).toString();
  const fromUri = (u: any) => monaco.Uri.parse(u).fsPath;
  const tabFor = (model: any) => state.openTabs.find((t) => t.model === model && !t.isUntitled);
  const pos = (p: any) => ({ line: p.lineNumber - 1, character: p.column - 1 });
  const toRange = (r: any) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
  const lspRange = (r: any) => ({ start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 } });
  const md = (c: any): any => {
    if (!c) return [];
    if (Array.isArray(c)) return c.flatMap(md);
    if (typeof c === 'string') return [{ value: c }];
    if (c.kind) return [{ value: c.value }];
    return [{ value: '```' + (c.language || '') + '\n' + c.value + '\n```' }];
  };

  // ---------- protocol client ----------
  class Client {
    [k: string]: any;
    constructor(key: any, lang: any, root: any) { Object.assign(this, { key, lang, root, id: null, seq: 0, pending: new Map(), caps: null, docs: new Map(), dead: false, name: '' }); }
    async start() {
      const res = await window.nexo.lspStart(this.lang, this.root);
      if (!res.ok) { this.dead = true; this.startError = res; return false; }
      this.id = res.id; this.name = res.command.replace(/\.(cmd|exe|bat)$/i, ''); byId.set(this.id, this);
      const init: any = await this.request('initialize', {
        initializationOptions: res.initializationOptions, processId: null, rootUri: toUri(this.root), rootPath: this.root, clientInfo: { name: 'Nexo Dev' },
        workspaceFolders: [{ uri: toUri(this.root), name: this.root.split(/[\\/]/).pop() }],
        capabilities: {
          workspace: { workspaceFolders: true, configuration: true },
          textDocument: {
            synchronization: { didSave: true },
            completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], resolveSupport: { properties: ['documentation', 'detail'] } } },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } },
            definition: { linkSupport: false }, references: {}, rename: { prepareSupport: false }, formatting: {}, rangeFormatting: {},
            codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'] } }, isPreferredSupport: true, resolveSupport: { properties: ['edit'] } },
            publishDiagnostics: { relatedInformation: false },
          },
          window: { workDoneProgress: false },
        },
      }, 60000).catch((err: any): any => { this.startError = { error: 'Initialize failed: ' + err.message }; return null; });
      if (!init) { this.stop(); return false; }
      this.caps = init.capabilities || {};
      this.notify('initialized', {});
      this.ready = true;
      return true;
    }
    request(method: any, params: any, timeout = 15000) {
      return new Promise((resolve, reject) => {
        const id = ++this.seq;
        const t = setTimeout(() => { this.pending.delete(id); reject(new Error('LSP timeout: ' + method)); }, timeout);
        this.pending.set(id, { resolve: (v: any) => { clearTimeout(t); resolve(v); }, reject: (e: any) => { clearTimeout(t); reject(e); } });
        window.nexo.lspSend(this.id, { jsonrpc: '2.0', id, method, params });
      });
    }
    notify(method: any, params: any) { if (!this.dead) window.nexo.lspSend(this.id, { jsonrpc: '2.0', method, params }); }
    handle(msg: any) {
      if (msg.id != null && (msg.result !== undefined || msg.error) && !msg.method) {
        const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); return;
      }
      if (msg.method && msg.id != null) { // server -> client request
        let result = null;
        if (msg.method === 'workspace/configuration') result = (msg.params.items || []).map((): any => null);
        if (msg.method === 'workspace/workspaceFolders') result = [{ uri: toUri(this.root), name: 'root' }];
        window.nexo.lspSend(this.id, { jsonrpc: '2.0', id: msg.id, result }); return;
      }
      if (msg.method === 'textDocument/publishDiagnostics') this.diagnostics(msg.params);
    }
    diagnostics({ uri, diagnostics }: any) {
      const doc = this.docs.get(uri); if (!doc) return;
      const sev: any = { 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint };
      monaco.editor.setModelMarkers(doc.model, 'lsp', diagnostics.map((d: any) => ({
        severity: sev[d.severity] || monaco.MarkerSeverity.Error, message: d.message, source: d.source, code: d.code != null ? String(d.code) : undefined,
        startLineNumber: d.range.start.line + 1, startColumn: d.range.start.character + 1, endLineNumber: d.range.end.line + 1, endColumn: d.range.end.character + 1,
      })));
    }
    syncKind() { const s = this.caps && this.caps.textDocumentSync; return typeof s === 'number' ? s : (s && s.change) || 0; }
    open(model: any, path: any) {
      const uri = toUri(path);
      if (this.docs.has(uri)) return;
      const doc: any = { model, uri, version: 1 };
      doc.sub = model.onDidChangeContent((e: any) => {
        doc.version++;
        const kind = this.syncKind();
        if (kind === 0) return;
        this.notify('textDocument/didChange', {
          textDocument: { uri, version: doc.version },
          contentChanges: kind === 2 ? e.changes.slice().sort((a: any, b: any) => b.rangeOffset - a.rangeOffset).map((c: any) => ({ range: lspRange(c.range), text: c.text })) : [{ text: model.getValue() }],
        });
      });
      model.onWillDispose(() => this.close(uri));
      this.docs.set(uri, doc);
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: model.getLanguageId(), version: 1, text: model.getValue() } });
    }
    close(uri: any) {
      const d = this.docs.get(uri); if (!d) return;
      d.sub.dispose(); this.docs.delete(uri);
      this.notify('textDocument/didClose', { textDocument: { uri } });
    }
    stop() {
      if (this.dead && !this.id) return;
      this.dead = true;
      if (this.id) { this.notify('shutdown', undefined); window.nexo.lspStop(this.id); byId.delete(this.id); }
      for (const uri of [...this.docs.keys()]) { const d = this.docs.get(uri); d.sub.dispose(); monaco.editor.setModelMarkers(d.model, 'lsp', []); }
      this.docs.clear(); clients.delete(this.key); paint();
    }
  }

  window.nexo.onLspMessage((id: any, msg: any) => { const c = byId.get(id); if (c) c.handle(msg); });
  window.nexo.onLspExit((id: any, code: any) => {
    const c = byId.get(id); if (!c) return;
    c.dead = true; byId.delete(id); clients.delete(c.key);
    for (const d of c.docs.values()) { d.sub.dispose(); monaco.editor.setModelMarkers(d.model, 'lsp', []); }
    c.docs.clear(); paint();
  });

  function clientFor(model: any) {
    const t = tabFor(model); if (!t || !state.projectRoot) return null;
    const lang = model.getLanguageId();
    const c = clients.get(`${(SERVER_KEY as any)[lang] || lang}|${state.projectRoot}`);
    return c && c.ready && !c.dead ? { c, path: t.path } : null;
  }
  const guard = (fn: any) => async (model: any, ...rest: any[]) => { const x = clientFor(model); if (!x) return undefined; try { return await fn(x.c, x.path, model, ...rest); } catch { return undefined; } };

  // Tabs use anonymous models, but Monaco's go-to/peek/rename machinery resolves targets
  // by URI. Mirror models (file:// URI) are created on demand for navigation targets and
  // disposed once the opener has taken over (or after a timeout).
  const mirrors = new Map(); // uri string -> { model, timer }
  async function ensureMirror(uri: any) {
    const key = uri.toString();
    if (monaco.editor.getModel(uri) || mirrors.has(key)) return;
    const p = uri.fsPath;
    const tab = state.openTabs.find((t) => t.path === p && t.model);
    let text = tab ? tab.model.getValue() : null;
    if (text == null) { const r = await window.nexo.readFile(p); if (!r || !r.ok) return; text = r.content; }
    if (monaco.editor.getModel(uri)) return;
    const model = monaco.editor.createModel(text, langFromName(p.split(/[\\/]/).pop()), uri);
    mirrors.set(key, { model, timer: setTimeout(() => dropMirror(key), 60000) });
  }
  function dropMirror(key: any) { const m = mirrors.get(key); if (!m) return; clearTimeout(m.timer); m.model.dispose(); mirrors.delete(key); }
  async function modelUriFor(uriStr: any) {
    const p = monaco.Uri.parse(uriStr).fsPath;
    let tab = state.openTabs.find((t) => t.path === p);
    if (!tab) { await openFile(p); tab = state.openTabs.find((t) => t.path === p); }
    return tab && tab.model ? tab.model.uri : null;
  }

  // WorkspaceEdit -> Monaco resource edits (edits must target the editor's own model, which is not keyed by file URI).
  async function toMonacoEdits(ws: any) {
    const edits: any = [];
    const batches: any = [];
    if (ws && ws.changes) Object.entries(ws.changes).forEach(([u, l]) => batches.push([u, l]));
    if (ws && ws.documentChanges) ws.documentChanges.forEach((d: any) => d.textDocument && batches.push([d.textDocument.uri, d.edits]));
    for (const [u, list] of batches) {
      const resource = await modelUriFor(u);
      if (resource) list.forEach((e: any) => edits.push({ resource, versionId: undefined, textEdit: { range: toRange(e.range), text: e.newText } }));
    }
    return edits;
  }
  const SEVERITY: any = { 8: 1, 4: 2, 2: 3, 1: 4 }; // Monaco MarkerSeverity -> LSP DiagnosticSeverity

  // ---------- Monaco providers (registered once per language) ----------
  function registerProviders(lang: any, caps: any) {
    if (registered.has(lang)) return;
    registered.add(lang);
    const kindMap = (k: any): any => { const K = monaco.languages.CompletionItemKind; return (<Record<number, any>>{ 1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field, 6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property, 11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet, 16: K.Color, 17: K.File, 18: K.Reference, 19: K.Folder, 20: K.EnumMember, 21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter })[k] || K.Text; };
    const L = monaco.languages;
    if (caps.completionProvider) L.registerCompletionItemProvider(lang, {
      triggerCharacters: caps.completionProvider.triggerCharacters || ['.'],
      provideCompletionItems: guard(async (c: any, path: any, model: any, position: any, ctx: any) => {
        const res = await c.request('textDocument/completion', { textDocument: { uri: toUri(path) }, position: pos(position), context: { triggerKind: [1, 2, 3][ctx.triggerKind] || 1, triggerCharacter: ctx.triggerCharacter } });
        const items = Array.isArray(res) ? res : (res && res.items) || [];
        const word = model.getWordUntilPosition(position);
        const defRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        return {
          incomplete: !!(res && res.isIncomplete),
          suggestions: items.map((it: any) => {
            const te = it.textEdit;
            const r = te ? (te.range || te.replace) : null;
            return {
              label: it.label, kind: kindMap(it.kind), detail: it.detail, sortText: it.sortText, filterText: it.filterText,
              documentation: it.documentation ? { value: md(it.documentation).map((m: any) => m.value).join('\n\n') } : undefined,
              insertText: (te && te.newText) || it.insertText || it.label,
              insertTextRules: it.insertTextFormat === 2 ? L.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              range: r ? toRange(r) : defRange,
              additionalTextEdits: (it.additionalTextEdits || []).map((e: any) => ({ range: toRange(e.range), text: e.newText })),
              tags: it.deprecated || (it.tags || []).includes(1) ? [1] : undefined, _lsp: it,
            };
          }),
        };
      }),
      resolveCompletionItem: async (item: any) => {
        const c = [...clients.values()].find((x) => x.ready && !x.dead && x.lang === lang) || [...clients.values()].find((x) => x.ready && !x.dead);
        if (!c || !caps.completionProvider.resolveProvider || !item._lsp) return item;
        try { const r = await c.request('completionItem/resolve', item._lsp); if (r.documentation) item.documentation = { value: md(r.documentation).map((m: any) => m.value).join('\n\n') }; if (r.detail) item.detail = r.detail; } catch { /* keep item */ }
        return item;
      },
    });
    if (caps.hoverProvider) L.registerHoverProvider(lang, {
      provideHover: guard(async (c: any, path: any, model: any, position: any) => {
        const h = await c.request('textDocument/hover', { textDocument: { uri: toUri(path) }, position: pos(position) });
        if (!h || !h.contents) return undefined;
        return { contents: md(h.contents), range: h.range ? toRange(h.range) : undefined };
      }),
    });
    const locs = async (res: any) => {
      const list = (res ? ([] as any[]).concat(res) : []).map((l) => ({ uri: monaco.Uri.parse(l.uri || l.targetUri), range: toRange(l.range || l.targetSelectionRange) }));
      await Promise.all(list.map((l) => ensureMirror(l.uri)));
      return list;
    };
    if (caps.definitionProvider) L.registerDefinitionProvider(lang, {
      provideDefinition: guard(async (c: any, path: any, model: any, position: any) => await locs(await c.request('textDocument/definition', { textDocument: { uri: toUri(path) }, position: pos(position) }))),
    });
    if (caps.referencesProvider) L.registerReferenceProvider(lang, {
      provideReferences: guard(async (c: any, path: any, model: any, position: any, ctx: any) => await locs(await c.request('textDocument/references', { textDocument: { uri: toUri(path) }, position: pos(position), context: { includeDeclaration: ctx.includeDeclaration } }, 30000))),
    });
    if (caps.signatureHelpProvider) L.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters || ['(', ','],
      provideSignatureHelp: guard(async (c: any, path: any, model: any, position: any) => {
        const s = await c.request('textDocument/signatureHelp', { textDocument: { uri: toUri(path) }, position: pos(position) });
        if (!s || !s.signatures || !s.signatures.length) return undefined;
        return { value: { activeSignature: s.activeSignature || 0, activeParameter: s.activeParameter || 0, signatures: s.signatures.map((g: any) => ({ label: g.label, documentation: g.documentation ? { value: md(g.documentation).map((m: any) => m.value).join('\n\n') } : undefined, parameters: (g.parameters || []).map((p: any) => ({ label: p.label, documentation: p.documentation ? { value: md(p.documentation).map((m: any) => m.value).join('\n\n') } : undefined })) })) }, dispose() {} };
      }),
    });
    if (caps.renameProvider) L.registerRenameProvider(lang, {
      provideRenameEdits: guard(async (c: any, path: any, model: any, position: any, newName: any) => {
        const ws = await c.request('textDocument/rename', { textDocument: { uri: toUri(path) }, position: pos(position), newName }, 30000);
        const edits = await toMonacoEdits(ws);
        return { edits };
      }),
    });
    if (caps.codeActionProvider) L.registerCodeActionProvider(lang, {
      provideCodeActions: guard(async (c: any, path: any, model: any, range: any, ctx: any) => {
        const diagnostics = ctx.markers.filter((m: any) => m.owner === 'lsp' || true).map((m: any) => ({ range: lspRange(m), message: m.message, severity: SEVERITY[m.severity] || 1, code: typeof m.code === 'object' ? m.code && m.code.value : m.code, source: m.source }));
        const res = await c.request('textDocument/codeAction', { textDocument: { uri: toUri(path) }, range: lspRange(range), context: { diagnostics, only: ctx.only ? [ctx.only] : undefined } }, 15000);
        const actions: any = [];
        for (const a of (res || [])) {
          if (!a || !a.title) continue;
          let edit = a.edit;
          if (!edit && a.data && caps.codeActionProvider.resolveProvider) { try { const r = await c.request('codeAction/resolve', a, 10000); edit = r && r.edit; } catch { /* unresolvable */ } }
          if (!edit && !a.command) continue;
          const edits = edit ? await toMonacoEdits(edit) : [];
          actions.push({
            title: a.title, kind: a.kind, isPreferred: !!a.isPreferred, diagnostics: undefined,
            edit: edits.length ? { edits } : undefined,
            command: a.command && !edits.length ? { id: 'nexo.lspExecute', title: a.title, arguments: [c.key, a.command] } : undefined,
          });
        }
        return { actions, dispose() {} };
      }),
    }, { providedCodeActionKinds: ['quickfix', 'refactor', 'source'] });
    if (caps.documentRangeFormattingProvider) L.registerDocumentRangeFormattingEditProvider(lang, {
      provideDocumentRangeFormattingEdits: guard(async (c: any, path: any, model: any, range: any, options: any) => {
        const r = await c.request('textDocument/rangeFormatting', { textDocument: { uri: toUri(path) }, range: lspRange(range), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } });
        return (r || []).map((e: any) => ({ range: toRange(e.range), text: e.newText }));
      }),
    });
    if (caps.documentFormattingProvider) L.registerDocumentFormattingEditProvider(lang, {
      provideDocumentFormattingEdits: guard(async (c: any, path: any, model: any, options: any) => {
        const r = await c.request('textDocument/formatting', { textDocument: { uri: toUri(path) }, options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } });
        return (r || []).map((e: any) => ({ range: toRange(e.range), text: e.newText }));
      }),
    });
  }

  // ---------- lifecycle ----------
  function paint() {
    const model = typeof editor !== 'undefined' && editor && editor.getModel();
    const lang = model && model.getLanguageId();
    const t = model && tabFor(model);
    if (!t || !LSP_LANGS.has(lang)) { statusEl.classList.add('hidden'); return; }
    const c = clients.get(`${(SERVER_KEY as any)[lang] || lang}|${state.projectRoot}`);
    statusEl.classList.remove('hidden');
    if (c && c.ready && !c.dead) { statusEl.textContent = `◉ ${c.name}`; statusEl.title = 'Language server running'; statusEl.className = 'lsp-on'; }
    else if (c && !c.ready && !c.dead) { statusEl.textContent = '◌ starting…'; statusEl.className = 'lsp-wait'; }
    else if (lastError[lang]) { statusEl.textContent = '○ no server'; statusEl.title = lastError[lang]; statusEl.className = 'lsp-off'; }
    else statusEl.classList.add('hidden');
  }
  const lastError: any = {};
  async function ensure(model: any) {
    const lang = model.getLanguageId();
    const t = tabFor(model);
    if (!t || !LSP_LANGS.has(lang) || !state.projectRoot ) return;
    const key = `${(SERVER_KEY as any)[lang] || lang}|${state.projectRoot}`;
    let c = clients.get(key);
    if (!c) {
      for (const [k, old] of clients) if (old.root !== state.projectRoot) old.stop(); // project switched
      if (lastError[lang] && lastError[lang + ':root'] === state.projectRoot) return;
      c = new Client(key, (SERVER_KEY as any)[lang] || lang, state.projectRoot);
      clients.set(key, c);
      c.starting = c.start().then((ok: any) => {
        if (!ok) {
          clients.delete(key);
          const e = c.startError || {};
          lastError[lang] = e.error || 'Language server failed to start.'; lastError[lang + ':root'] = state.projectRoot;
          if (e.code === 'missing' && !warned.has(lang)) { warned.add(lang); flashToast(`No ${lang} language server found (${e.command}). Install it for completions & diagnostics.`); }
        } else {
          delete lastError[lang];
          const effective = ['typescript', 'javascript'].includes(c.lang);
          [c.lang, ...(c.lang === 'typescript' ? ['javascript'] : [])].forEach((l) => registerProviders(l, c.caps));
          if (effective) disableBuiltinTs();
        }
        paint();
        return ok;
      });
      paint();
    }
    await c.starting;
    if (c.ready && !c.dead) { c.open(model, t.path); paint(); }
  }
  function disableBuiltinTs() {
    const off = { completionItems: false, hovers: false, documentSymbols: false, definitions: false, references: false, documentHighlights: false, rename: false, diagnostics: false, signatureHelp: false, onTypeFormattingEdits: false, codeActions: false, inlayHints: false };
    for (const d of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) d.setModeConfiguration({ ...d.modeConfiguration, ...off });
  }

  // Cross-file go-to-definition: open the target in a tab rather than a bare Monaco model.
  function installOpener() {
    monaco.editor.registerEditorOpener({
      openCodeEditor(source: any, resource: any, selection: any) {
        if (resource.scheme !== 'file') return false;
        const p = resource.fsPath;
        setTimeout(() => dropMirror(resource.toString()), 0);
        if (state.openTabs.some((t) => t.path === p) && editor.getModel() && (state.openTabs.find((t) => t.path === p).model === editor.getModel())) return false;
        openFile(p).then(() => { if (selection && editor) { const s = selection.startLineNumber ? { lineNumber: selection.startLineNumber, column: selection.startColumn } : selection; editor.setPosition(s); editor.revealPositionInCenter(s); editor.focus(); } });
        return true;
      },
    });
  }

  // Go to definition implemented directly against the server: Monaco's built-in command can only
  // navigate between models keyed by URI, while tabs here use anonymous models.
  async function goToDefinition(ed: any) {
    const model = ed.getModel(); const x = model && clientFor(model);
    if (!x) return false;
    const p = ed.getPosition();
    let res;
    try { res = await x.c.request('textDocument/definition', { textDocument: { uri: toUri(x.path) }, position: pos(p) }); } catch { return false; }
    const loc = ([] as any[]).concat(res || [])[0];
    if (!loc) { flashToast('No definition found'); return true; }
    const range = toRange(loc.range || loc.targetSelectionRange);
    const target = fromUri(loc.uri || loc.targetUri);
    if (target !== x.path) await openFile(target);
    if (!editor.getModel()) return true;
    editor.setPosition(range.getStartPosition());
    editor.revealRangeInCenter(range);
    editor.focus();
    return true;
  }
  window.nexoGoToDefinition = goToDefinition;

  async function init() {
    for (let i = 0; i < 600 && !(window.monaco && typeof monacoLoaded !== 'undefined' && monacoLoaded && typeof editor !== 'undefined' && editor); i++) await sleep(100);
    if (!window.monaco) return;
    installOpener();
    editor.addAction({ id: 'nexo.lsp.goToDefinition', label: 'Go to Definition (Language Server)', keybindings: [monaco.KeyCode.F12], contextMenuGroupId: 'navigation', contextMenuOrder: 1.4, run: (ed: any) => goToDefinition(ed) });
    editor.onMouseDown((e: any) => {
      const m = e.event; if (!(m.ctrlKey || m.metaKey) || !m.leftButton || !e.target.position) return;
      editor.setPosition(e.target.position); goToDefinition(editor);
    });
    const sweep = () => state.openTabs.forEach((t) => { if (t.model) ensure(t.model); });
    registerLspCommand();
    monaco.editor.onDidCreateModel((m: any) => setTimeout(() => ensure(m), 50));
    editor.onDidChangeModel(() => {
      const m = editor.getModel();
      const key = m && m.uri.toString();
      if (m && mirrors.has(key)) { // Monaco swapped in a navigation mirror: hand over to a real tab
        setTimeout(async () => {
          const sel = editor.getModel() === m ? editor.getSelection() : null;
          await openFile(m.uri.fsPath);
          dropMirror(key);
          if (sel && editor.getModel() && editor.getModel() !== m) { editor.setSelection(sel); editor.revealRangeInCenter(sel); editor.focus(); }
        }, 0);
        return;
      }
      if (m) ensure(m);
      paint();
    });
    setInterval(sweep, 3000); // picks up project switches / late tab registration cheaply (no-op when already open)
    sweep();
    window.__lspReady = true;
  }
  init();

  async function setServers(patch: any) {
    const merged: any = { ...(uiState.lspServers || {}), ...patch };
    uiState.lspServers = merged;
    await window.nexo.setPrefs({ lspServers: merged });
  }
  PALETTE_COMMANDS.push(
    { label: 'Language Servers: Restart', run: () => { [...clients.values()].forEach((c) => c.stop()); Object.keys(lastError).forEach((k) => delete lastError[k]); warned.clear(); if (editor && editor.getModel()) ensure(editor.getModel()); } },
    { label: 'Language Servers: Enable Project-Aware TypeScript/JavaScript', run: async () => {
      const cfg: any = { command: 'typescript-language-server', args: ['--stdio'] };
      await setServers({ typescript: cfg, javascript: cfg });
      flashToast('TypeScript language server enabled (install it in your project: npm i -D typescript typescript-language-server).');
      Object.keys(lastError).forEach((k) => delete lastError[k]);
      if (editor && editor.getModel()) ensure(editor.getModel());
    } },
    { label: 'Language Servers: Set Server Command for Current Language…', run: async () => {
      const m = editor && editor.getModel(); if (!m) return;
      const lang = m.getLanguageId();
      const cmd = prompt(`Language server command for "${lang}" (e.g. gopls, or full path + args):`, '');
      if (!cmd) return;
      const [command, ...args] = cmd.trim().split(/\s+/);
      await setServers({ [lang]: { command, args } });
      Object.keys(lastError).forEach((k) => delete lastError[k]); ensure(m);
    } },
  );
  // Code-action commands the server wants executed (workspace/executeCommand).
  const registerLspCommand = () => monaco.editor.registerCommand('nexo.lspExecute', async (_acc: any, key: any, cmd: any) => {
    const c = clients.get(key); if (!c || !c.ready) return;
    try { await c.request('workspace/executeCommand', { command: cmd.command, arguments: cmd.arguments }, 20000); } catch (e) { flashToast('Server command failed: ' + e.message); }
  });

  // Server status / install hints. Install commands are only ever shown or pasted into the terminal input,
  // never run automatically.
  async function showServerStatus() {
    if (!state.projectRoot) { flashToast('Open a folder first.'); return; }
    const res = await window.nexo.lspStatus(state.projectRoot);
    const host = document.getElementById('modal-overlay');
    const rows = (res.rows || []).map((r: any) => {
      const badge = r.state === 'found' ? '● installed' : r.state === 'available' ? '○ installed (opt-in)' : '✕ missing';
      return `<tr><td>${escapeHtml(r.lang)}</td><td>${escapeHtml(r.name || r.command || '')}</td><td class="lsp-${r.state}">${badge}</td><td>${r.state === 'missing' && r.installCmd ? `<code>${escapeHtml(r.installCmd)}</code> <button class="git-section-action" data-cmd="${escapeHtml(r.installCmd)}">Run in terminal…</button>` : escapeHtml(r.path || '')}</td></tr>`;
    }).join('');
    const box = document.createElement('div');
    box.id = 'lsp-status-dialog'; box.className = 'lsp-status-dialog';
    box.innerHTML = `<div class="lsp-status-card"><h3>Language Servers</h3><div class="lsp-status-scroll"><table class="db-grid"><thead><tr><th>Language</th><th>Server</th><th>Status</th><th>Path / install</th></tr></thead><tbody>${rows}</tbody></table></div><div class="lsp-status-actions"><button class="tbtn" id="lsp-status-close">Close</button></div></div>`;
    document.body.append(box);
    box.querySelector('#lsp-status-close')!.addEventListener('click', () => box.remove());
    box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
    box.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => {
      const cmd = b.dataset.cmd;
      if (confirm(`Run this in the project terminal?\n\n${cmd}`)) { box.remove(); runCommandInTerminal(cmd); }
    }));
  }
  PALETTE_COMMANDS.push({ label: 'Language Servers: Show Status & Install Hints', run: showServerStatus });
  window.__lsp = { clients, showServerStatus };
})();
