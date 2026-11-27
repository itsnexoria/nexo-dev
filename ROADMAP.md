# Roadmap

## Hardening / tech debt
- [x] `strictNullChecks` enabled (DOM lookups use `!` assertions; replace with real null handling over time)
- [ ] Migrate `src/legacy/*` to real modules; drop `order.json` concatenation
- [x] `main.js` split: python, git+GitHub, stores, Discord, updater extracted (1970 → ~800 lines). Remaining in main: window/menu, fs/search/dialog handlers, terminal runner, prettier/npm helpers
- [ ] Drop `'unsafe-inline'` from CSP `style-src`
- [ ] Reduce `any` usage; type `window.nexo`
- [x] Extension permission manifest (enforced; no interactive capability prompt yet)

## Features
- [x] Theme preset import/export (file dialog path not e2e-tested)
- [ ] Settings sync
- [x] File-vs-file diff (open tab or clipboard; clipboard path not e2e-tested)
- [ ] Multi-window / detachable terminal
- [x] More LSP servers + private npm auto-install
- [ ] Additional DAP debuggers (Go, Rust, C/C++)
- [x] Tasks runner + problems panel (package.json, .nexo/tasks.json, .vscode/tasks.json)
- [ ] DB client: history, CSV/JSON export; HTTP client: environments, Postman import
- [ ] Sites monitor: SSL expiry, reports, webhooks
- [ ] i18n, keymap import, settings search

## Release
- [x] Tag-driven release CI (signing activates once CSC_* secrets are set)
- [x] Workspace Trust / Restricted Mode
- [x] Dependabot, Electron 45

## Done in the latest pass
- [x] Remote terminals (SSH / Docker / dev container) — terminal only; remote file system editing is still open
- [x] Emmet, bookmarks (in-memory, not persisted across restarts), fold presets

## Investigated, not done
- [ ] Multi-window / detachable terminal: IPC events (file watch, LSP, PTY, debugger) are routed to a single `mainWindow`; needs per-sender routing first
- [ ] CSP without `unsafe-inline`: tried — dropping it from `style-src` immediately produces "Refused to apply inline style" violations (Monaco injects `<style>` elements at runtime with no nonce hook)
- [ ] `asar` + integrity: needs `asarUnpack` for Python helpers/native modules and Windows packaging verification
