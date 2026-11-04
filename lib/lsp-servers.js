'use strict';
// Table of known language servers + pure resolution logic (no spawning, no fs except via the injected finder).
// Each entry: languages it serves (Monaco language ids), the executable, args, how to install it, and
// whether it is opt-in (Monaco already ships built-in support, so a server is only used when the user asks).
const NPM = (pkgs) => `npm i -D ${pkgs}`;
const SERVERS = [
  { id: 'typescript-language-server', name: 'TypeScript / JavaScript', langs: ['typescript', 'javascript'], command: 'typescript-language-server', args: ['--stdio'], optIn: true, install: { npm: NPM('typescript typescript-language-server') } },
  { id: 'pyright', name: 'Pyright', langs: ['python'], command: 'pyright-langserver', args: ['--stdio'], install: { npm: NPM('pyright'), other: 'pip install pyright' } },
  { id: 'basedpyright', name: 'basedpyright', langs: ['python'], command: 'basedpyright-langserver', args: ['--stdio'], install: { npm: NPM('basedpyright'), other: 'pip install basedpyright' }, fallbackOf: 'python' },
  { id: 'pylsp', name: 'python-lsp-server', langs: ['python'], command: 'pylsp', args: [], install: { other: 'pip install python-lsp-server' }, fallbackOf: 'python' },
  { id: 'gopls', name: 'gopls', langs: ['go'], command: 'gopls', args: [], install: { other: 'go install golang.org/x/tools/gopls@latest' } },
  { id: 'rust-analyzer', name: 'rust-analyzer', langs: ['rust'], command: 'rust-analyzer', args: [], install: { other: 'rustup component add rust-analyzer' } },
  { id: 'clangd', name: 'clangd', langs: ['c', 'cpp'], command: 'clangd', args: [], install: { other: 'Install clangd via your package manager (apt install clangd / brew install llvm)' } },
  { id: 'jdtls', name: 'Eclipse JDT LS', langs: ['java'], command: 'jdtls', args: [], install: { other: 'brew install jdtls (or download from eclipse.org/jdtls)' } },
  { id: 'intelephense', name: 'Intelephense', langs: ['php'], command: 'intelephense', args: ['--stdio'], install: { npm: NPM('intelephense') } },
  { id: 'solargraph', name: 'Solargraph', langs: ['ruby'], command: 'solargraph', args: ['stdio'], install: { other: 'gem install solargraph' } },
  { id: 'bash-language-server', name: 'bash-language-server', langs: ['shell'], command: 'bash-language-server', args: ['start'], install: { npm: NPM('bash-language-server') } },
  { id: 'yaml-language-server', name: 'yaml-language-server', langs: ['yaml'], command: 'yaml-language-server', args: ['--stdio'], install: { npm: NPM('yaml-language-server') } },
  { id: 'lua-language-server', name: 'lua-language-server', langs: ['lua'], command: 'lua-language-server', args: [], install: { other: 'brew install lua-language-server (or see luals.github.io)' } },
  { id: 'vscode-json-language-server', name: 'JSON', langs: ['json', 'jsonc'], command: 'vscode-json-language-server', args: ['--stdio'], optIn: true, initOptions: { provideFormatter: true }, install: { npm: NPM('vscode-langservers-extracted') } },
  { id: 'vscode-css-language-server', name: 'CSS / SCSS / Less', langs: ['css', 'scss', 'less'], command: 'vscode-css-language-server', args: ['--stdio'], optIn: true, initOptions: { provideFormatter: true }, install: { npm: NPM('vscode-langservers-extracted') } },
  { id: 'vscode-html-language-server', name: 'HTML', langs: ['html'], command: 'vscode-html-language-server', args: ['--stdio'], optIn: true, initOptions: { provideFormatter: true }, install: { npm: NPM('vscode-langservers-extracted') } },
];

const LANGUAGES = [...new Set(SERVERS.flatMap((s) => s.langs))];

// Primary (non-fallback) entry per language, then its fallbacks in table order.
function entriesFor(lang) {
  const all = SERVERS.filter((s) => s.langs.includes(lang));
  return [...all.filter((s) => !s.fallbackOf), ...all.filter((s) => s.fallbackOf)];
}

// The map lib/lsp.js uses as defaults: { lang: { command, args, alt?, optIn? } }.
function defaultServers() {
  const out = {};
  for (const lang of LANGUAGES) {
    const [first, ...rest] = entriesFor(lang);
    out[lang] = { command: first.command, args: first.args };
    if (first.optIn) out[lang].optIn = true;
    if (first.initOptions) out[lang].initOptions = first.initOptions;
    if (rest.length) out[lang].alt = rest.map((s) => ({ command: s.command, args: s.args }));
  }
  return out;
}

const cleanUser = (u) => (u && typeof u.command === 'string' && u.command.trim() ? { command: u.command.trim(), args: Array.isArray(u.args) ? u.args.filter((a) => typeof a === 'string') : [] } : null);

// Resolve how `lang` would be served: user override > detected default.
// find(cmd) -> absolute path or null. Returns a plain status object suitable for the UI.
function resolveStatus(lang, { userServers = {}, find } = {}) {
  const entries = entriesFor(lang);
  if (!entries.length && !cleanUser(userServers[lang])) return null;
  const user = cleanUser(userServers[lang]);
  const row = { lang, source: 'none', command: null, args: [], path: null, state: 'missing', optIn: false, name: null, install: null, candidates: [] };
  const primary = entries[0];
  if (primary) { row.name = primary.name; row.install = primary.install; row.optIn = !!primary.optIn; }
  if (user) {
    const exe = find ? find(user.command) : null;
    Object.assign(row, { source: 'user', command: user.command, args: user.args, path: exe, state: exe ? 'found' : 'missing' });
    return row;
  }
  for (const e of entries) {
    const exe = find ? find(e.command) : null;
    row.candidates.push({ id: e.id, name: e.name, command: e.command, found: !!exe, install: e.install });
    if (exe && row.state !== 'found') Object.assign(row, { command: e.command, args: e.args, path: exe, state: 'found', name: e.name, install: e.install, source: 'default' });
  }
  if (row.state === 'missing' && primary) { row.command = primary.command; row.args = primary.args; row.source = 'default'; }
  if (row.state === 'found' && row.optIn) row.state = 'available'; // installed, but not enabled (Monaco's built-in support is used)
  return row;
}

// Install hint -> a single shell command (never executed here; the UI asks the user to confirm).
function installCommand(row) {
  const i = row && row.install; if (!i) return null;
  return i.npm || i.other || null;
}

module.exports = { SERVERS, LANGUAGES, entriesFor, defaultServers, resolveStatus, installCommand };
