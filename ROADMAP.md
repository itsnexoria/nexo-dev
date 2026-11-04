# Roadmap

## Hardening / tech debt
- [x] `strictNullChecks` enabled (DOM lookups use `!` assertions; replace with real null handling over time)
- [ ] Migrate `src/legacy/*` to real modules; drop `order.json` concatenation
- [ ] Split `main.js` into `lib/ipc-*.js` (Python extracted → `lib/ipc-python.js`; still to go: git, GitHub, window/menu, updater, Discord, prefs/session stores)
- [ ] Drop `'unsafe-inline'` from CSP `style-src`
- [ ] Reduce `any` usage; type `window.nexo`
- [ ] Extension permission manifest + capability prompts

## Features
- [ ] Settings sync, theme preset import/export
- [x] File-vs-file diff (open tab or clipboard; clipboard path not e2e-tested)
- [ ] Multi-window / detachable terminal
- [ ] Additional DAP debuggers (Go, Rust, C/C++), more LSP servers
- [ ] Tasks runner + problems panel
- [ ] DB client: history, CSV/JSON export; HTTP client: environments, Postman import
- [ ] Sites monitor: SSL expiry, reports, webhooks
- [ ] i18n, keymap import, settings search

## Release
- [ ] Code signing / notarization, tag-driven release CI
- [ ] Dependabot/Renovate, bump Electron
