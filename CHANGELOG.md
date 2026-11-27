
## Unreleased
### Security
- Workspace Trust: untrusted folders open in Restricted Mode (no project-local LSP/ESLint/Prettier/venv execution).
- Electron 31 -> 45; `safeStorage` rejects the Linux `basic_text` backend; Git auth no longer edits the user's git config; `protocol.ext` blocked on clone; CSV formula-injection guard; PTY cwd is scope-checked.
- Extensions: enforced permissions, protected paths, sandbox globals removed from the whole prototype chain.
### Fixed
- SQLite runs in a worker with a statement timeout; regex search/replace run in a worker with a timeout.
- Non-UTF-8 files are no longer corrupted on save/replace; git status uses `-z` (spaces/unicode paths); build/dist folders are visible; untracked-file discard; detached-HEAD push; longer push/pull timeout; atomic writes for app data; GitHub lists paginate.
### Added
- Tasks runner + Problems panel; persistent bookmarks; Dependabot; release workflow; `npm audit` in CI.
