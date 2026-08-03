const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexo', {
  // dialogs
  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  newProject: () => ipcRenderer.invoke('dialog:new-project'),
  pickFolder: (title) => ipcRenderer.invoke('dialog:pick-folder', title),
  cloneRepo: (url, destParentDir) => ipcRenderer.invoke('git:clone', url, destParentDir),
  saveAsDialog: (defaultName) => ipcRenderer.invoke('dialog:save-as', defaultName),
  revealInFolder: (targetPath) => ipcRenderer.invoke('shell:reveal', targetPath),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  notifyReady: () => ipcRenderer.send('app:ready'),

  // site monitoring + SEO audits
  getSites: () => ipcRenderer.invoke('sites:get'),
  addSite: (url, name) => ipcRenderer.invoke('sites:add', url, name),
  removeSite: (id) => ipcRenderer.invoke('sites:remove', id),
  checkSite: (id) => ipcRenderer.invoke('sites:check', id),
  auditSite: (id) => ipcRenderer.invoke('sites:audit', id),
  setSiteInterval: (id, minutes) => ipcRenderer.invoke('sites:set-interval', id, minutes),
  onSitesUpdated: (callback) => ipcRenderer.on('sites:updated', (evt, list) => callback(list)),

  // global search
  searchText: (rootPath, query, opts) => ipcRenderer.invoke('search:text', rootPath, query, opts),
  replaceAll: (rootPath, query, replacement, opts) => ipcRenderer.invoke('search:replace-all', rootPath, query, replacement, opts),
  listFiles: (rootPath) => ipcRenderer.invoke('fs:list-files', rootPath),

  // git
  gitStatus: (projectRoot) => ipcRenderer.invoke('git:status', projectRoot),
  gitDiff: (projectRoot, relPath, staged) => ipcRenderer.invoke('git:diff', projectRoot, relPath, staged),
  gitStage: (projectRoot, relPath) => ipcRenderer.invoke('git:stage', projectRoot, relPath),
  gitUnstage: (projectRoot, relPath) => ipcRenderer.invoke('git:unstage', projectRoot, relPath),
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
  lintFile: (projectRoot, filePath, content) => ipcRenderer.invoke('eslint:lint', projectRoot, filePath, content),

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
  onOpenPath: (callback) => ipcRenderer.on('open-path', (evt, p) => callback(p)),

  // auto-update
  checkForUpdates: (manual) => ipcRenderer.invoke('update:check', manual),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update:available', (evt, version) => callback(version)),
  onUpdateNotAvailable: (callback) => ipcRenderer.on('update:not-available', () => callback()),
  onUpdateProgress: (callback) => ipcRenderer.on('update:progress', (evt, percent) => callback(percent)),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update:downloaded', () => callback()),
  onUpdateError: (callback) => ipcRenderer.on('update:error', (evt, message) => callback(message)),

  // menu events
  onMenu: (channel, callback) => {
    const valid = ['menu:open-folder', 'menu:new-file', 'menu:save', 'menu:save-as', 'menu:toggle-sidebar', 'menu:toggle-terminal', 'menu:toggle-split', 'menu:toggle-zen', 'menu:show-search', 'menu:show-git', 'menu:check-updates'];
    if (valid.includes(channel)) ipcRenderer.on(channel, callback);
  },
});
