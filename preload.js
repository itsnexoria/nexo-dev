const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Files dragged in from the OS are the one way the user grants new filesystem scope from
// inside the window. Only genuine (isTrusted) drop events count, and the path comes from
// Electron's webUtils, never from page-supplied strings.
window.addEventListener('drop', (e) => {
  if (!e.isTrusted || !e.dataTransfer || !e.dataTransfer.files.length) return;
  const paths = Array.from(e.dataTransfer.files).map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean);
  if (paths.length) ipcRenderer.invoke('scope:grant-drop', paths);
}, true);

contextBridge.exposeInMainWorld('nexo', {
  // dialogs
  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  newProject: () => ipcRenderer.invoke('dialog:new-project'),
  pickFolder: (title) => ipcRenderer.invoke('dialog:pick-folder', title),
  pickFile: (title, filters) => ipcRenderer.invoke('dialog:pick-file', title, filters),
  cloneRepo: (url, destParentDir) => ipcRenderer.invoke('git:clone', url, destParentDir),
  saveAsDialog: (defaultName) => ipcRenderer.invoke('dialog:save-as', defaultName),
  revealInFolder: (targetPath) => ipcRenderer.invoke('shell:reveal', targetPath),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  // Discord Rich Presence
  setDiscordActivity: (details, state) => ipcRenderer.invoke('discord:set-activity', details, state),
  notifyReady: () => ipcRenderer.send('app:ready'),

  // global search
  searchText: (rootPath, query, opts) => ipcRenderer.invoke('search:text', rootPath, query, opts),
  replaceAll: (rootPath, query, replacement, opts) => ipcRenderer.invoke('search:replace-all', rootPath, query, replacement, opts),
  listFiles: (rootPath) => ipcRenderer.invoke('fs:list-files', rootPath),

  // git
  gitStatus: (projectRoot) => ipcRenderer.invoke('git:status', projectRoot),
  gitDiff: (projectRoot, relPath, staged) => ipcRenderer.invoke('git:diff', projectRoot, relPath, staged),
  gitStage: (projectRoot, relPath) => ipcRenderer.invoke('git:stage', projectRoot, relPath),
  gitStageAll: (projectRoot) => ipcRenderer.invoke('git:stage-all', projectRoot),
  gitUnstage: (projectRoot, relPath) => ipcRenderer.invoke('git:unstage', projectRoot, relPath),
  gitUnstageAll: (projectRoot) => ipcRenderer.invoke('git:unstage-all', projectRoot),
  gitDiscard: (projectRoot, relPath) => ipcRenderer.invoke('git:discard', projectRoot, relPath),
  gitCommit: (projectRoot, message) => ipcRenderer.invoke('git:commit', projectRoot, message),
  gitBranches: (projectRoot) => ipcRenderer.invoke('git:branches', projectRoot),
  gitCheckoutBranch: (projectRoot, branchName) => ipcRenderer.invoke('git:checkout-branch', projectRoot, branchName),
  gitCreateBranch: (projectRoot, branchName) => ipcRenderer.invoke('git:create-branch', projectRoot, branchName),
  gitLog: (projectRoot, limit) => ipcRenderer.invoke('git:log', projectRoot, limit),
  gitIgnoredPaths: (projectRoot) => ipcRenderer.invoke('git:ignored-paths', projectRoot),
  gitBlame: (projectRoot, filePath) => ipcRenderer.invoke('git:blame', projectRoot, filePath),

  // GitHub API
  setGithubToken: (token) => ipcRenderer.invoke('github:set-token', token),
  getGithubUser: () => ipcRenderer.invoke('github:get-user'),
  clearGithubToken: () => ipcRenderer.invoke('github:clear-token'),
  hasGithubToken: () => ipcRenderer.invoke('github:has-token'),
  listGithubRepos: () => ipcRenderer.invoke('github:list-repos'),
  createGithubRepo: (opts) => ipcRenderer.invoke('github:create-repo', opts),
  listGithubPulls: (projectRoot) => ipcRenderer.invoke('github:list-pulls', projectRoot),
  listGithubIssues: (projectRoot) => ipcRenderer.invoke('github:list-issues', projectRoot),
  listGithubReleases: (projectRoot) => ipcRenderer.invoke('github:list-releases', projectRoot),
  createGithubRelease: (projectRoot, opts) => ipcRenderer.invoke('github:create-release', projectRoot, opts),
  setGithubSecret: (projectRoot, secretName, secretValue) => ipcRenderer.invoke('github:set-secret', projectRoot, secretName, secretValue),
  lintFile: (projectRoot, filePath, content) => ipcRenderer.invoke('eslint:lint', projectRoot, filePath, content),
  checkOutdated: (projectRoot, forceRefresh) => ipcRenderer.invoke('npm:outdated', projectRoot, !!forceRefresh),
  pyInfo: (projectRoot) => ipcRenderer.invoke('py:info', projectRoot),
  pySelect: (projectRoot, dir) => ipcRenderer.invoke('py:select', projectRoot, dir),
  pyResolve: (projectRoot) => ipcRenderer.invoke('py:resolve', projectRoot),
  pyLint: (projectRoot, filePath, content) => ipcRenderer.invoke('py:lint', projectRoot, filePath, content),
  pyLintReset: (projectRoot) => ipcRenderer.invoke('py:lint-reset', projectRoot),
  pyTests: (projectRoot) => ipcRenderer.invoke('py:tests', projectRoot),
  pyIntel: (projectRoot, req) => ipcRenderer.invoke('py:intel', projectRoot, req),
  pyIntelReset: () => ipcRenderer.invoke('py:intel-reset'),
  nbRun: (projectRoot, nbPath, code) => ipcRenderer.invoke('nb:run', projectRoot, nbPath, code),
  nbRestart: (nbPath) => ipcRenderer.invoke('nb:restart', nbPath),
  pyList: (projectRoot, pythonBin) => ipcRenderer.invoke('py:list', projectRoot, pythonBin),
  pyOutdated: (projectRoot, pythonBin, forceRefresh) => ipcRenderer.invoke('py:outdated', projectRoot, pythonBin, !!forceRefresh),
  formatWithPrettier: (projectRoot, filePath, content) => ipcRenderer.invoke('prettier:format', projectRoot, filePath, content),
  scanTodos: (projectRoot) => ipcRenderer.invoke('todos:scan', projectRoot),
  getRecentFiles: () => ipcRenderer.invoke('recent-files:get'),
  addRecentFile: (filePath, projectRoot) => ipcRenderer.invoke('recent-files:add', filePath, projectRoot),

  // external file-change watching
  watchFile: (filePath) => ipcRenderer.invoke('watch:start', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('watch:stop', filePath),
  onFileChanged: (callback) => ipcRenderer.on('file-changed', (evt, filePath) => callback(filePath)),
  gitShowCommit: (projectRoot, hash) => ipcRenderer.invoke('git:show-commit', projectRoot, hash),
  gitRemoteStatus: (projectRoot) => ipcRenderer.invoke('git:remote-status', projectRoot),
  gitPush: (projectRoot) => ipcRenderer.invoke('git:push', projectRoot),
  gitPull: (projectRoot) => ipcRenderer.invoke('git:pull', projectRoot),

  // file moves (drag-and-drop in the explorer)
  moveItem: (sourcePath, destDir) => ipcRenderer.invoke('fs:move', sourcePath, destDir),

  // preferences
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  saveSession: (projectRoot, data) => ipcRenderer.invoke('session:save', projectRoot, data),
  loadSession: (projectRoot) => ipcRenderer.invoke('session:load', projectRoot),
  setPrefs: (partial) => ipcRenderer.invoke('prefs:set', partial),

  // command runner (safe alternative to a full terminal)
  runCommand: (cwd, command) => ipcRenderer.invoke('term:run', cwd, command),
  writeCommand: (id, text) => ipcRenderer.invoke('term:write', id, text),
  pyFormat: (projectRoot, filePath, content) => ipcRenderer.invoke('py:format', projectRoot, filePath, content),
  dbgStart: (projectRoot, file, bps) => ipcRenderer.invoke('dbg:start', projectRoot, file, bps),
  dbgControl: (cmd) => ipcRenderer.invoke('dbg:control', cmd),
  dbgStop: () => ipcRenderer.invoke('dbg:stop'),
  dbgWrite: (text) => ipcRenderer.invoke('dbg:write', text),
  dbgSetBreakpoints: (file, lines) => ipcRenderer.invoke('dbg:set-breakpoints', file, lines),
  dbgFrameVars: (frameId) => ipcRenderer.invoke('dbg:frame-vars', frameId),
  dbgEval: (expr, frameId) => ipcRenderer.invoke('dbg:eval', expr, frameId),
  onDbgEvent: (cb) => ipcRenderer.on('dbg:event', (_e, name, payload) => cb(name, payload)),
  killCommand: (id) => ipcRenderer.invoke('term:kill', id),
  onTermData: (callback) => ipcRenderer.on('term:data', (evt, id, chunk) => callback(id, chunk)),
  onTermExit: (callback) => ipcRenderer.on('term:exit', (evt, id, code) => callback(id, code)),

  // recent projects
  getRecent: () => ipcRenderer.invoke('recent:get'),
  removeRecent: (folderPath) => ipcRenderer.invoke('recent:remove', folderPath),

  // filesystem
  readDir: (dirPath) => ipcRenderer.invoke('fs:read-dir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:write-file', filePath, content),
  createFile: (dirPath, name) => ipcRenderer.invoke('fs:create-file', dirPath, name),
  createFolder: (dirPath, name) => ipcRenderer.invoke('fs:create-folder', dirPath, name),
  deleteItem: (targetPath) => ipcRenderer.invoke('fs:delete', targetPath),
  rename: (oldPath, newName) => ipcRenderer.invoke('fs:rename', oldPath, newName),
  exists: (targetPath) => ipcRenderer.invoke('fs:exists', targetPath),
  statPath: (targetPath) => ipcRenderer.invoke('fs:stat', targetPath),
  resolveEditorConfig: (projectRoot, filePath) => ipcRenderer.invoke('editorconfig:resolve', projectRoot, filePath),
  onOpenPath: (callback) => ipcRenderer.on('open-path', (evt, p) => callback(p)),

  // auto-update
  checkForUpdates: (manual) => ipcRenderer.invoke('update:check', manual),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  reloadWindow: () => ipcRenderer.invoke('app:reload'),
  toggleDevTools: () => ipcRenderer.invoke('app:toggle-devtools'),
  toggleFullscreen: () => ipcRenderer.invoke('app:toggle-fullscreen'),
  showAbout: () => ipcRenderer.invoke('app:show-about'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update:available', (evt, version) => callback(version)),
  onUpdateNotAvailable: (callback) => ipcRenderer.on('update:not-available', () => callback()),
  onUpdateProgress: (callback) => ipcRenderer.on('update:progress', (evt, percent) => callback(percent)),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update:downloaded', () => callback()),
  onUpdateError: (callback) => ipcRenderer.on('update:error', (evt, message) => callback(message)),

  // live server / http client / database viewer
  liveStart: (root, port) => ipcRenderer.invoke('live:start', root, port),
  liveStop: () => ipcRenderer.invoke('live:stop'),
  liveStatus: () => ipcRenderer.invoke('live:status'),
  httpSend: (req, vars) => ipcRenderer.invoke('http:send', req, vars),
  httpStoreLoad: () => ipcRenderer.invoke('http:store-load'),
  httpStoreSave: (doc) => ipcRenderer.invoke('http:store-save', doc),
  httpParseCurl: (text) => ipcRenderer.invoke('http:parse-curl', text),
  httpToCurl: (req, vars) => ipcRenderer.invoke('http:to-curl', req, vars),
  dbPick: () => ipcRenderer.invoke('db:pick'),
  dbTables: (file) => ipcRenderer.invoke('db:tables', file),
  dbSchema: (file, table) => ipcRenderer.invoke('db:schema', file, table),
  dbBrowse: (file, table, limit, offset) => ipcRenderer.invoke('db:browse', file, table, limit, offset),
  dbQuery: (file, sql) => ipcRenderer.invoke('db:query', file, sql),

  // interactive terminal (PTY)
  ptyAvailable: () => ipcRenderer.invoke('pty:available'),
  ptySpawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
  ptyWrite: (id, data) => ipcRenderer.invoke('pty:write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', id, cols, rows),
  ptyKill: (id) => ipcRenderer.invoke('pty:kill', id),
  onPtyData: (cb) => ipcRenderer.on('pty:data', (evt, id, data) => cb(id, data)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (evt, id, code) => cb(id, code)),

  // language servers
  lspStart: (lang, root) => ipcRenderer.invoke('lsp:start', lang, root),
  lspStatus: (root) => ipcRenderer.invoke('lsp:status', root),
  extList: () => ipcRenderer.invoke('ext:list'),
  extSetEnabled: (id, on) => ipcRenderer.invoke('ext:set-enabled', id, on),
  extOpenFolder: () => ipcRenderer.invoke('ext:open-folder'),
  lspSend: (id, msg) => ipcRenderer.invoke('lsp:send', id, msg),
  lspStop: (id) => ipcRenderer.invoke('lsp:stop', id),
  onLspMessage: (cb) => ipcRenderer.on('lsp:message', (evt, id, msg) => cb(id, msg)),
  onLspExit: (cb) => ipcRenderer.on('lsp:exit', (evt, id, code, error) => cb(id, code, error)),

  // Node/TypeScript debugger (CDP)
  njsStart: (projectRoot, file, bps) => ipcRenderer.invoke('njs:start', projectRoot, file, bps),
  njsControl: (cmd) => ipcRenderer.invoke('njs:control', cmd),
  njsStop: () => ipcRenderer.invoke('njs:stop'),
  njsWrite: (text) => ipcRenderer.invoke('njs:write', text),
  njsSetBreakpoints: (file, lines) => ipcRenderer.invoke('njs:set-breakpoints', file, lines),
  njsFrameVars: (frameId) => ipcRenderer.invoke('njs:frame-vars', frameId),
  njsEval: (expr, frameId) => ipcRenderer.invoke('njs:eval', expr, frameId),
  onNjsEvent: (cb) => ipcRenderer.on('njs:event', (_e, name, payload) => cb(name, payload)),


  // database manager (sqlite / postgres / mysql)
  dbcList: () => ipcRenderer.invoke('dbc:list'),
  dbcSave: (profile, password) => ipcRenderer.invoke('dbc:save', profile, password),
  dbcDelete: (id) => ipcRenderer.invoke('dbc:delete', id),
  dbcConnect: (id) => ipcRenderer.invoke('dbc:connect', id),
  dbcConnectFile: (file, allowWrites) => ipcRenderer.invoke('dbc:connect-file', file, allowWrites),
  dbcDisconnect: (connId) => ipcRenderer.invoke('dbc:disconnect', connId),
  dbcSetWrites: (connId, allow) => ipcRenderer.invoke('dbc:set-writes', connId, allow),
  dbcTables: (connId) => ipcRenderer.invoke('dbc:tables', connId),
  dbcSchema: (connId, table) => ipcRenderer.invoke('dbc:schema', connId, table),
  dbcBrowse: (connId, table, limit, offset) => ipcRenderer.invoke('dbc:browse', connId, table, limit, offset),
  dbcQuery: (connId, sql) => ipcRenderer.invoke('dbc:query', connId, sql),
  dbcUpdate: (connId, edit) => ipcRenderer.invoke('dbc:update', connId, edit),
  dbcExportCsv: (connId, src) => ipcRenderer.invoke('dbc:export-csv', connId, src),
  dbcSaveSqlite: (connId) => ipcRenderer.invoke('dbc:save-sqlite', connId),

  // git extras: hunks, stash, graph
  gitHunks: (root, rel, staged) => ipcRenderer.invoke('git:hunks', root, rel, staged),
  gitApplySelection: (root, rel, mode, selection) => ipcRenderer.invoke('git:apply-selection', root, rel, mode, selection),
  gitFileVersions: (root, rel, staged) => ipcRenderer.invoke('git:file-versions', root, rel, staged),
  gitCommitVersions: (root, hash, rel) => ipcRenderer.invoke('git:commit-versions', root, hash, rel),
  gitCommitFiles: (root, hash) => ipcRenderer.invoke('git:commit-files', root, hash),
  gitStashList: (root) => ipcRenderer.invoke('git:stash-list', root),
  gitStashPush: (root, message, includeUntracked) => ipcRenderer.invoke('git:stash-push', root, message, includeUntracked),
  gitStashApply: (root, i) => ipcRenderer.invoke('git:stash-apply', root, i),
  gitStashPop: (root, i) => ipcRenderer.invoke('git:stash-pop', root, i),
  gitStashDrop: (root, i) => ipcRenderer.invoke('git:stash-drop', root, i),
  gitStashShow: (root, i) => ipcRenderer.invoke('git:stash-show', root, i),
  gitGraph: (root, limit) => ipcRenderer.invoke('git:graph', root, limit),
  gitFileHistory: (root, rel) => ipcRenderer.invoke('git:file-history', root, rel),

  // menu events
  onMenu: (channel, callback) => {
    const valid = ['menu:open-folder', 'menu:new-file', 'menu:save', 'menu:save-as', 'menu:toggle-sidebar', 'menu:toggle-terminal', 'menu:toggle-split', 'menu:toggle-zen', 'menu:show-search', 'menu:show-git', 'menu:check-updates'];
    if (valid.includes(channel)) ipcRenderer.on(channel, callback);
  },
});
