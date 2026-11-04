
// Live Server, HTTP client and Database viewer. Loaded after renderer.js and
// relies on its globals (state, switchRailView, FULL_WORKSPACES, PALETTE_COMMANDS, flashToast).
'use strict';
(function () {
  const $ = (sel: any, root = document) => root.querySelector(sel);
  const el = (tag: any, props: Record<string, any> = {}, ...kids: any[]) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  };
  const SVG = {
    http: '<path d="M4 12h16M14 6l6 6-6 6"/>',
    data: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.300 8-3V6M4 12v6c0 1.700 3.600 3 8 3s8-1.300 8-3v-6"/>',
  };
  const railIcon = (body: any) => `<svg class="rail-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  function addWorkspace(id: any, label: any, title: any, icon: any, build: any) {
    const view = id;
    const ws = el('div', { id: `workspace-${view}`, class: 'workspace' });
    $('#workspace-settings').after(ws);
    FULL_WORKSPACES[view] = `workspace-${view}`;
    const btn = el('button', { class: 'rail-btn', id: `rail-${view}`, 'data-view': view, title });
    btn.innerHTML = `<span class="rail-icon">${railIcon(icon)}</span><span class="rail-label">${label}</span>`;
    btn.addEventListener('click', () => switchRailView(view));
    $('#rail-settings').before(btn);
    build(ws);
    return ws;
  }

  // ---------------- Live Server ----------------
  const live = { running: false, url: '' };
  const goLive = el('button', { class: 'tbtn', id: 'btn-go-live', title: 'Start Live Server for this project', text: '⚡ Go Live' });
  $('#btn-toggle-terminal').before(goLive);
  const statusLive = el('span', { id: 'status-live', class: 'hidden', title: 'Click to open in browser' });
  $('#status-right').prepend(statusLive);

  function paintLive() {
    goLive.textContent = live.running ? '■ Stop Server' : '⚡ Go Live';
    goLive.classList.toggle('live-on', live.running);
    statusLive.classList.toggle('hidden', !live.running);
    statusLive.textContent = live.running ? `● ${live.url.replace(/^https?:\/\//, '')}` : '';
  }
  async function startLive() {
    if (!state.projectRoot) { flashToast('Open a folder first.'); return; }
    const res = await window.nexo.liveStart(state.projectRoot);
    if (!res.ok) { flashToast(res.error || 'Could not start server.'); return; }
    Object.assign(live, { running: true, url: res.url });
    paintLive();
    flashToast(`Live Server running at ${res.url}`);
    window.nexo.openExternal(res.url);
  }
  async function stopLive() { await window.nexo.liveStop(); live.running = false; paintLive(); flashToast('Live Server stopped.'); }
  goLive.addEventListener('click', () => (live.running ? stopLive() : startLive()));
  statusLive.addEventListener('click', () => live.running && window.nexo.openExternal(live.url));
  window.nexo.liveStatus().then((s) => { if (s.running) { Object.assign(live, { running: true, url: s.url }); paintLive(); } });

  // ---------------- HTTP client ----------------
  const hc: any = { doc: { folders: [], envs: [], activeEnv: null, history: [] }, current: null }; // current = collection request id being edited
  let saveTimer: any = null;
  const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => window.nexo.httpStoreSave(hc.doc), 300); };
  const activeVars = () => { const e = hc.doc.envs.find((x: any) => x.id === hc.doc.activeEnv); return e ? e.vars : {}; };
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => b.toString(16).padStart(2, '0')).join('');

  function parseHeaders(text: any) {
    const h: any = {};
    for (const line of text.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return h;
  }
  const headersToText = (h: any) => (Array.isArray(h) ? h.map((x) => `${x.name}: ${x.value}`).join('\n') : String(h || ''));
  function prettyBody(res: any) {
    const ct = (res.headers['content-type'] || '');
    if (/json/i.test(ct) || /^\s*[\[{]/.test(res.body)) { try { return JSON.stringify(JSON.parse(res.body), null, 2); } catch { /* not JSON */ } }
    return res.body;
  }

  addWorkspace('http', 'HTTP', 'HTTP Client', SVG.http, (ws: any) => {
    const method = el('select', { id: 'http-method' }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => el('option', { text: m })));
    const url = el('input', { id: 'http-url', type: 'text', placeholder: 'https://api.example.com/items/{{id}}', spellcheck: 'false' });
    const send = el('button', { class: 'tbtn primary', id: 'http-send', text: 'Send' });
    const headers = el('textarea', { id: 'http-headers', placeholder: 'Header-Name: value\nAuthorization: Bearer {{token}}', spellcheck: 'false' });
    const body = el('textarea', { id: 'http-body', placeholder: 'Request body (JSON, text…)', spellcheck: 'false' });
    const side = el('div', { id: 'http-side', class: 'http-side' });
    const meta = el('div', { id: 'http-meta', class: 'http-meta' });
    const resHeaders = el('pre', { id: 'http-res-headers' });
    const resBody = el('pre', { id: 'http-res-body' });
    const find = el('input', { id: 'http-find', type: 'search', placeholder: 'Filter response lines…', spellcheck: 'false' });
    let lastBody = '';
    const showBody = () => {
      const q = find.value.trim().toLowerCase();
      resBody.textContent = q ? lastBody.split('\n').filter((l) => l.toLowerCase().includes(q)).join('\n') : lastBody;
    };
    find.addEventListener('input', showBody);

    const readForm = () => ({ method: method.value, url: url.value.trim(), headers: headers.value, body: body.value });
    const loadForm = (r: any) => { method.value = r.method || 'GET'; url.value = r.url || ''; headers.value = headersToText(r.headers); body.value = r.body || ''; };

    function renderSide() {
      const items = [];
      // environments
      const envSel = el('select', { id: 'http-env' }, el('option', { value: '', text: 'No environment' }), ...hc.doc.envs.map((e: any) => el('option', { value: e.id, text: e.name })));
      envSel.value = hc.doc.activeEnv || '';
      envSel.addEventListener('change', () => { hc.doc.activeEnv = envSel.value || null; persist(); });
      items.push(el('div', { class: 'http-pane-title', text: 'ENVIRONMENT' }), el('div', { class: 'http-env-row' }, envSel,
        el('button', { class: 'tbtn', id: 'http-env-edit', text: 'Edit…', onclick: editEnv }), el('button', { class: 'tbtn', id: 'http-env-new', text: '+', title: 'New environment', onclick: newEnv })));
      // collections
      items.push(el('div', { class: 'http-pane-title' }, el('span', { text: 'COLLECTIONS' }), el('button', { class: 'git-section-action', id: 'http-folder-new', text: '+ Folder', onclick: newFolder })));
      for (const f of hc.doc.folders) {
        items.push(el('div', { class: 'http-folder' }, el('span', { text: '📁 ' + f.name }), el('span', { class: 'hunk-actions' },
          el('button', { class: 'git-section-action', text: 'Save here', title: 'Save the current request into this folder', onclick: () => saveInto(f) }),
          el('button', { class: 'git-section-action danger', text: '✕', onclick: () => { if (confirm(`Delete folder "${f.name}" and its requests?`)) { hc.doc.folders = hc.doc.folders.filter((x: any) => x !== f); persist(); renderSide(); } } }))));
        for (const r of f.requests) {
          items.push(el('div', { class: 'http-hist-item' + (hc.current === r.id ? ' active' : ''), title: r.url, onclick: () => { hc.current = r.id; loadForm(r); renderSide(); } },
            el('span', { class: `http-m m-${r.method}`, text: r.method }), el('span', { class: 'http-hu', text: r.name }),
            el('span', { class: 'http-x', title: 'Delete', text: '✕', onclick: (e: any) => { e.stopPropagation(); f.requests = f.requests.filter((x: any) => x !== r); persist(); renderSide(); } })));
        }
      }
      if (!hc.doc.folders.length) items.push(el('div', { class: 'db-note', text: 'No collections yet.' }));
      // history
      items.push(el('div', { class: 'http-pane-title' }, el('span', { text: 'HISTORY' }), el('button', { class: 'git-section-action', text: 'Clear', onclick: () => { hc.doc.history = []; persist(); renderSide(); } })));
      for (const h of hc.doc.history.slice(0, 30)) {
        items.push(el('div', { class: 'http-hist-item', title: h.url, onclick: () => { hc.current = null; loadForm(h); renderSide(); } },
          el('span', { class: `http-m m-${h.method}`, text: h.method }), el('span', { class: 'http-hu', text: h.url.replace(/^https?:\/\//, '') })));
      }
      side.replaceChildren(...items);
    }
    function newFolder() {
      showModal({ title: 'New collection folder', confirmLabel: 'Create', fields: [{ id: 'name', label: 'Name', placeholder: 'My API' }],
        onConfirm: (v: any) => { if (!v.name.trim()) return 'Name is required.'; hc.doc.folders.push({ id: rid(), name: v.name.trim(), requests: [] }); persist(); renderSide(); } });
    }
    function saveInto(folder: any) {
      const cur = readForm();
      if (!cur.url) { flashToast('Enter a URL first.'); return; }
      showModal({ title: 'Save request', confirmLabel: 'Save', fields: [{ id: 'name', label: 'Name', initial: cur.url.replace(/^https?:\/\//, '').slice(0, 60) }],
        onConfirm: (v: any) => { const r = { id: rid(), name: v.name.trim() || 'Untitled', ...cur }; folder.requests.push(r); hc.current = r.id; persist(); renderSide(); } });
    }
    function newEnv() {
      showModal({ title: 'New environment', confirmLabel: 'Create', fields: [{ id: 'name', label: 'Name', placeholder: 'Staging' }],
        onConfirm: (v: any) => { if (!v.name.trim()) return 'Name is required.'; const e = { id: rid(), name: v.name.trim(), vars: {} }; hc.doc.envs.push(e); hc.doc.activeEnv = e.id; persist(); renderSide(); setTimeout(editEnv, 50); } });
    }
    function editEnv() {
      const e = hc.doc.envs.find((x: any) => x.id === hc.doc.activeEnv);
      if (!e) { flashToast('Create or select an environment first.'); return; }
      showModal({ title: `Variables — ${e.name}`, confirmLabel: 'Save', fields: [{ id: 'vars', label: 'One per line: name=value  (use as {{name}})', initial: Object.entries(e.vars).map(([k, v]) => `${k}=${v}`).join('; ') }],
        onConfirm: (v: any) => {
          const vars: any = {};
          for (const part of v.vars.split(/;|\n/)) { const i = part.indexOf('='); if (i > 0) vars[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
          e.vars = vars; persist();
        } });
    }
    async function importCurl() {
      showModal({ title: 'Import from cURL', confirmLabel: 'Import', fields: [{ id: 'cmd', label: 'Paste a curl command', placeholder: "curl -X POST 'https://…' -H '…' -d '…'" }],
        onConfirm: async (v: any) => {
          const r = await window.nexo.httpParseCurl(v.cmd);
          if (!r.ok) return r.error;
          hc.current = null; loadForm(r.request);
          if (r.request.warnings && r.request.warnings.length) flashToast(r.request.warnings[0]);
        } });
    }
    async function copyCurl() {
      const f = readForm();
      const r = await window.nexo.httpToCurl({ method: f.method, url: f.url, headers: parseHeaders(f.headers), body: f.body || undefined }, {});
      if (r.ok) { await navigator.clipboard.writeText(r.curl); flashToast('Copied as cURL (variables left as {{…}}).'); }
    }
    async function doSend() {
      if (!url.value.trim()) return;
      send.disabled = true; send.textContent = 'Sending…';
      meta.className = 'http-meta'; meta.textContent = '';
      const f = readForm();
      const res = await window.nexo.httpSend({ method: f.method, url: f.url, headers: parseHeaders(f.headers), body: f.body || undefined }, activeVars());
      send.disabled = false; send.textContent = 'Send';
      hc.doc.history = [{ id: rid(), name: f.url.slice(0, 60), ...f, at: Date.now(), status: res.ok ? res.status : null }, ...hc.doc.history.filter((h: any) => !(h.method === f.method && h.url === f.url))].slice(0, 50);
      persist(); renderSide();
      if (!res.ok) { meta.className = 'http-meta err'; meta.textContent = res.error; resHeaders.textContent = ''; resBody.textContent = ''; return; }
      meta.className = `http-meta ${res.status < 400 ? 'ok' : 'err'}`;
      meta.textContent = `${res.status} ${res.statusText}  ·  ${res.timeMs} ms  ·  ${(res.size / 1024).toFixed(1)} KB${res.truncated ? ' (truncated)' : ''}${res.unresolved && res.unresolved.length ? `  ·  unresolved: ${res.unresolved.map((k: any) => `{{${k}}}`).join(' ')}` : ''}`;
      resHeaders.textContent = Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
      lastBody = prettyBody(res); showBody();
    }
    send.addEventListener('click', doSend);
    url.addEventListener('keydown', (e: any) => { if (e.key === 'Enter') doSend(); });
    ws.append(el('div', { class: 'tool-page' },
      el('h2', { text: 'HTTP Client' }),
      el('div', { class: 'http-bar' }, method, url, send, el('button', { class: 'tbtn', id: 'http-import-curl', text: 'Import cURL', onclick: importCurl }), el('button', { class: 'tbtn', id: 'http-copy-curl', text: 'Copy as cURL', onclick: copyCurl })),
      el('div', { class: 'http-layout' }, side,
        el('div', { class: 'http-cols' },
          el('div', { class: 'http-col' }, el('div', { class: 'http-pane-title', text: 'HEADERS' }), headers, el('div', { class: 'http-pane-title', text: 'BODY' }), body),
          el('div', { class: 'http-col' }, el('div', { class: 'http-pane-title', text: 'RESPONSE' }), meta,
            el('div', { class: 'http-pane-title', text: 'HEADERS' }), resHeaders, el('div', { class: 'http-pane-title' }, el('span', { text: 'BODY' }), find), resBody)))));
    window.nexoHttp = { loadForm, hc };
    window.nexo.httpStoreLoad().then((r) => { if (r.ok) hc.doc = r.doc; renderSide(); });
  });

  // ---------------- Database manager (SQLite / PostgreSQL / MySQL) ----------------
  const db: any = { connId: null, cfg: null, table: null, page: 0, pageSize: 100, browse: null, dirty: false };
  const fmtCell = (v: any) => (v === null ? 'NULL' : String(v));
  function renderGrid(host: any, res: any, opts: any = {}) {
    if (!res.ok) { host.replaceChildren(el('div', { class: 'db-error', text: res.error })); return; }
    if (!res.columns.length) { host.replaceChildren(el('div', { class: 'db-note', text: res.affected != null ? `Statement ran. ${res.affected} row(s) affected.` : 'Query ran. No rows returned.' })); return; }
    const head = el('tr', {}, ...res.columns.map((c: any) => el('th', { text: c })));
    const rows = res.rows.map((r: any, ri: any) => el('tr', {}, ...r.map((v: any, ci: any) => {
      const td = el('td', v === null ? { class: 'null', text: 'NULL' } : { text: String(v) });
      if (opts.editable && db.cfg && db.cfg.allowWrites && res.rowKeys && res.rowKeys[ri]) {
        td.classList.add('editable');
        td.addEventListener('dblclick', () => editCell(td, res, ri, ci, v));
      }
      return td;
    })));
    host.replaceChildren(
      el('table', { class: 'db-grid' }, el('thead', {}, head), el('tbody', {}, ...rows)),
      el('div', { class: 'db-note', text: `${res.rows.length} row${res.rows.length === 1 ? '' : 's'}${res.truncated ? ' (first 1000 shown)' : ''}${res.timeMs != null ? ` · ${res.timeMs} ms` : ''}${opts.editable && res.editable === false ? ' · read-only grid (table has no primary key)' : ''}` }));
  }
  function editCell(td: any, res: any, ri: any, ci: any, oldVal: any) {
    const input = el('input', { class: 'db-cell-input', type: 'text', value: oldVal === null ? '' : String(oldVal) });
    td.replaceChildren(input); input.focus(); input.select();
    let done = false;
    const finish = async (commit: any) => {
      if (done) return; done = true;
      if (!commit || input.value === (oldVal === null ? '' : String(oldVal))) { td.textContent = fmtCell(oldVal); return; }
      const r = await window.nexo.dbcUpdate(db.connId, { table: db.table, set: { [res.columns[ci]]: input.value }, where: res.rowKeys[ri] });
      if (!r.ok) { flashToast(r.error); td.textContent = fmtCell(oldVal); return; }
      db.dirty = true; paintDirty();
      td.textContent = input.value; flashToast('Cell updated');
    };
    input.addEventListener('keydown', (e: any) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
  }
  let ui: any = null; // element handles, set by the workspace builder
  function paintDirty() {
    if (!ui) return;
    ui.saveBtn.classList.toggle('hidden', !(db.dirty && db.cfg && db.cfg.driver === 'sqlite'));
    ui.writes.checked = !!(db.cfg && db.cfg.allowWrites);
    ui.writesWrap.classList.toggle('hidden', !db.connId);
    ui.exportBtn.classList.toggle('hidden', !db.connId);
  }
  async function loadSavedList() {
    const r = await window.nexo.dbcList();
    ui.saved.replaceChildren(...(r.ok ? r.connections : []).map((c: any) => el('div', { class: 'db-conn', 'data-id': c.id },
      el('span', { class: 'db-conn-name', text: `${c.driver === 'postgres' ? '🐘' : c.driver === 'mysql' ? '🐬' : '🗄️'} ${c.name}`, onclick: () => connectSaved(c) }),
      el('span', { class: 'db-conn-x', title: 'Delete connection', text: '✕', onclick: async () => { if (confirm(`Delete connection "${c.name}"?`)) { await window.nexo.dbcDelete(c.id); loadSavedList(); } } }))));
  }
  async function connectSaved(c: any) {
    ui.status.textContent = `Connecting to ${c.name}…`;
    const r = await window.nexo.dbcConnect(c.id);
    if (!r.ok) { ui.status.textContent = ''; flashToast(r.error); return; }
    await attach(r.connId, c);
  }
  async function attach(connId: any, cfg: any) {
    if (db.connId && db.connId !== connId) window.nexo.dbcDisconnect(db.connId);
    Object.assign(db, { connId, cfg, table: null, page: 0, dirty: false });
    ui.status.textContent = `${cfg.name} (${cfg.driver})`;
    const res = await window.nexo.dbcTables(connId);
    if (!res.ok) { flashToast(res.error); return; }
    const key = (t: any) => (t.schema ? `${t.schema}.${t.name}` : t.name);
    ui.tables.replaceChildren(...res.tables.map((t: any) => el('div', { class: 'db-table', 'data-name': t.name, onclick: () => pickTable(t) },
      el('span', { text: (t.type === 'view' ? '◫ ' : '▦ ') + key(t) }), el('span', { class: 'db-count', text: t.count == null ? '' : String(t.count) }))));
    ui.out.replaceChildren(el('div', { class: 'db-note', text: res.tables.length ? 'Pick a table.' : 'No tables found.' }));
    paintDirty();
    if (res.tables.length) pickTable(res.tables[0]);
  }
  async function pickTable(t: any, page = 0) {
    db.table = t.schema ? { schema: t.schema, name: t.name } : t.name; db.page = page;
    const q = (n: any) => (db.cfg.driver === 'mysql' ? '`' + n.replace(/`/g, '``') + '`' : '"' + n.replace(/"/g, '""') + '"');
    ui.sql.value = `SELECT * FROM ${t.schema ? q(t.schema) + '.' : ''}${q(t.name)} LIMIT 100;`;
    const [cols, rows] = await Promise.all([window.nexo.dbcSchema(db.connId, db.table), window.nexo.dbcBrowse(db.connId, db.table, db.pageSize, page * db.pageSize)]);
    ui.schema.textContent = cols.ok ? cols.columns.map((c: any) => `${c.pk ? '🔑 ' : ''}${c.name} ${c.type}`).join('   ·   ') : '';
    db.browse = rows;
    renderGrid(ui.out, rows, { editable: true });
    ui.pager.classList.toggle('hidden', !rows.ok);
    ui.pageLabel.textContent = `Page ${page + 1}`;
    ui.prev.disabled = page === 0; ui.next.disabled = !rows.ok || rows.rows.length < db.pageSize;
    ui.tables.querySelectorAll('.db-table').forEach((x: any) => x.classList.toggle('active', x.dataset.name === t.name));
    db.tableEntry = t;
  }
  async function openFile(file: any) {
    const r = await window.nexo.dbcConnectFile(file, false);
    if (!r.ok) { flashToast(r.error || 'Could not open database.'); return; }
    if (ui) ui.file.textContent = file;
    await attach(r.connId, { driver: 'sqlite', name: file.split(/[\\/]/).pop(), file, allowWrites: false });
  }
  window.nexoOpenDatabase = openFile;

  function connectionForm() {
    const f: any = {};
    const field = (id: any, label: any, props: any = {}) => { f[id] = el('input', { id: `dbf-${id}`, type: props.type || 'text', placeholder: props.ph || '', value: props.value || '', autocomplete: 'off', spellcheck: 'false' }); return el('label', { class: 'db-field' }, el('span', { text: label }), f[id]); };
    f.driver = el('select', { id: 'dbf-driver' }, el('option', { value: 'postgres', text: 'PostgreSQL' }), el('option', { value: 'mysql', text: 'MySQL / MariaDB' }));
    f.ssl = el('input', { type: 'checkbox', id: 'dbf-ssl' });
    const err = el('div', { class: 'db-error' });
    const form = el('div', { class: 'db-form' },
      el('label', { class: 'db-field' }, el('span', { text: 'Type' }), f.driver),
      field('name', 'Name', { ph: 'Production (read-only)' }), field('host', 'Host', { value: 'localhost' }), field('port', 'Port', { ph: 'default' }),
      field('user', 'User'), field('password', 'Password', { type: 'password' }), field('database', 'Database'),
      el('label', { class: 'db-check' }, f.ssl, el('span', { text: 'Use SSL' })), err,
      el('div', { class: 'db-form-actions' },
        el('button', { class: 'tbtn primary', text: 'Save & connect', onclick: async () => {
          const profile = { name: f.name.value, driver: f.driver.value, host: f.host.value, port: f.port.value || undefined, user: f.user.value, database: f.database.value, ssl: f.ssl.checked, allowWrites: false };
          const r = await window.nexo.dbcSave(profile, f.password.value);
          if (!r.ok) { err.textContent = r.error; return; }
          form.remove(); await loadSavedList();
          const list = await window.nexo.dbcList(); const saved = list.connections.find((c: any) => c.id === r.id); if (saved) connectSaved(saved);
        } }),
        el('button', { class: 'tbtn', text: 'Cancel', onclick: () => form.remove() })));
    return form;
  }

  addWorkspace('data', 'Data', 'Database Manager', SVG.data, (ws: any) => {
    ui = {};
    ui.file = el('span', { id: 'db-file', class: 'db-file', text: 'No database open' });
    ui.status = el('span', { class: 'db-file' });
    ui.saved = el('div', { id: 'db-saved' });
    ui.tables = el('div', { id: 'db-tables' });
    ui.schema = el('div', { id: 'db-schema' });
    ui.sql = el('textarea', { id: 'db-sql', placeholder: 'SELECT * FROM table LIMIT 50;   (Ctrl+Enter to run)', spellcheck: 'false' });
    ui.out = el('div', { id: 'db-result' });
    ui.writes = el('input', { type: 'checkbox', id: 'db-allow-writes' });
    ui.writesWrap = el('label', { class: 'db-check hidden', title: 'Off by default: the connection is read-only until you opt in.' }, ui.writes, el('span', { text: 'Allow writes' }));
    ui.saveBtn = el('button', { class: 'tbtn primary hidden', id: 'db-save', text: 'Save changes to file', onclick: async () => { const r = await window.nexo.dbcSaveSqlite(db.connId); if (r.ok) { db.dirty = false; paintDirty(); flashToast('Database file saved.'); } else flashToast(r.error); } });
    ui.exportBtn = el('button', { class: 'tbtn hidden', id: 'db-export', text: 'Export CSV', onclick: async () => {
      const sql = ui.sql.value.trim();
      const r = await window.nexo.dbcExportCsv(db.connId, sql ? { sql } : { table: db.table });
      if (r.ok && !r.canceled) flashToast(`Exported ${r.rows} rows${r.truncated ? ' (truncated)' : ''}.`); else if (!r.ok) flashToast(r.error);
    } });
    ui.prev = el('button', { class: 'tbtn', text: '‹ Prev', onclick: () => db.tableEntry && pickTable(db.tableEntry, db.page - 1) });
    ui.next = el('button', { class: 'tbtn', text: 'Next ›', onclick: () => db.tableEntry && pickTable(db.tableEntry, db.page + 1) });
    ui.pageLabel = el('span', { class: 'db-note' });
    ui.pager = el('div', { class: 'db-pager hidden' }, ui.prev, ui.pageLabel, ui.next);
    ui.writes.addEventListener('change', async () => {
      if (ui.writes.checked && !confirm('Enable writes for this connection? Queries and cell edits can then change your data.')) { ui.writes.checked = false; return; }
      const r = await window.nexo.dbcSetWrites(db.connId, ui.writes.checked);
      if (!r.ok) { flashToast(r.error); ui.writes.checked = false; return; }
      db.cfg.allowWrites = ui.writes.checked;
      if (db.tableEntry) pickTable(db.tableEntry, db.page);
    });
    async function runSql() {
      if (!db.connId || !ui.sql.value.trim()) return;
      const r = await window.nexo.dbcQuery(db.connId, ui.sql.value);
      renderGrid(ui.out, r); ui.pager.classList.add('hidden');
      if (r.ok && db.cfg.driver === 'sqlite' && db.cfg.allowWrites && !/^\s*(select|with|pragma|explain)\b/i.test(ui.sql.value)) { db.dirty = true; paintDirty(); }
    }
    ui.sql.addEventListener('keydown', (e: any) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); runSql(); } });
    const openBtn = el('button', { class: 'tbtn primary', id: 'db-open', text: 'Open SQLite file…', onclick: async () => { const r = await window.nexo.dbPick(); if (r.ok) openFile(r.file); } });
    const newBtn = el('button', { class: 'tbtn', id: 'db-new', text: '+ Connection…', onclick: () => ui.side.prepend(connectionForm()) });
    ui.side = el('div', { class: 'db-side' }, el('div', { class: 'http-pane-title', text: 'CONNECTIONS' }), ui.saved, el('div', { class: 'http-pane-title', text: 'TABLES' }), ui.tables);
    ws.append(el('div', { class: 'tool-page db-page' },
      el('h2', { text: 'Database Manager' }),
      el('div', { class: 'http-bar' }, openBtn, newBtn, ui.file, ui.status, el('span', { class: 'db-spacer' }), ui.writesWrap, ui.saveBtn, ui.exportBtn),
      el('div', { class: 'db-layout' }, ui.side,
        el('div', { class: 'db-main' }, ui.schema, ui.sql, el('div', {}, el('button', { class: 'tbtn', id: 'db-run', text: '▶ Run', onclick: runSql })), ui.out, ui.pager))));
    loadSavedList();
  });

  // ---------------- Palette commands ----------------
  PALETTE_COMMANDS.push(
    { label: 'Live Server: Start', run: startLive },
    { label: 'Live Server: Stop', run: stopLive },
    { label: 'Live Server: Open in Browser', run: () => live.running ? window.nexo.openExternal(live.url) : startLive() },
    { label: 'HTTP Client: New Request', run: () => switchRailView('http') },
    { label: 'Database: New Connection (Postgres/MySQL)…', run: () => { switchRailView('data'); document.getElementById('db-new')!.click(); } },
    { label: 'Database: Open SQLite File…', run: async () => { switchRailView('data'); const r = await window.nexo.dbPick(); if (r.ok) window.nexoOpenDatabase(r.file); } },
  );
})();
