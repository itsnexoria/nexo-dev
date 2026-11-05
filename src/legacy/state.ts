/* global monaco, require */

// ---------------- State ----------------
interface AppState {
  projectRoot: string | null; roots: string[]; workspaceFile: string | null; expanded: Set<string>;
  openTabs: any[]; activeTab: string | null; contextTarget: any; showIgnored: boolean; selectedPaths: Set<string>;
  projectSettingsActive: boolean; [extra: string]: any;
}
const state: AppState = {
  projectRoot: null,   // the *active* root (git, scripts, python, terminal cwd all follow it)
  roots: [],           // all workspace folders (length > 1 => multi-root workspace)
  workspaceFile: null, // path of the loaded .nexo-workspace file, if any
  expanded: new Set(),
  openTabs: [],      // [{path, name, model, viewState, modified, isUntitled}]
  activeTab: null,
  contextTarget: null, // {path, isDirectory} for right-click actions
  showIgnored: false,
  selectedPaths: new Set(), // multi-select in the file tree
  projectSettingsActive: false, // whether the open project has a .nexo/settings.json override
};

const uiState: Record<string, any> = {
  theme: 'dark',
  fontSize: 13.5,
  minimap: true,
  wordWrap: false,
  bracketGuides: false,
  vimMode: false,
  formatOnSave: false,
  scriptsOrder: [],
  snippets: [],
  autoSave: false,
  autoSaveDelayMs: 1000,
  customShell: '',
  customTheme: { bg: '#0c0c10', text: '#ececf0', accent: '#ff3b30' },
  customThemes: [],
  discordRpcEnabled: false,
  discordClientId: '',
};
const splitState: Record<string, any> = { visible: false, tabPath: null, mdMode: null };
let splitEditor: any = null;
let editor: any = null;
let dragSourcePath: any = null;
let monacoLoaded = false;
let monacoReadyPromise: Promise<void> | null = null;

const LANG_MAP = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp',
  php: 'php', sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml',
  xml: 'xml', sql: 'sql', txt: 'plaintext', env: 'plaintext',
  lua: 'lua', kt: 'kotlin', kts: 'kotlin', swift: 'swift', dockerfile: 'dockerfile', graphql: 'graphql', gql: 'graphql', ps1: 'powershell',
};

function langFromName(name: string): string {
  const ext = name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : (name.toLowerCase() === 'dockerfile' ? 'dockerfile' : '');
  return (LANG_MAP as Record<string, string>)[ext] || 'plaintext';
}
