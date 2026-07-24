# Nexo Dev

A lightweight, standalone code editor and project manager for Windows — built with Electron + Monaco (the same editor engine as VS Code).

## Features

Five views, switchable from the icon rail on the far left. Files, Search, and Git share the same tabbed editor; Sites and Settings are separate workspaces.

### 📁 Files — code editor & project manager
- **Open Folder / New Project** — open any local folder as a project, or create a new one
- **File tree** — expand/collapse folders, right-click to create, rename, delete, or reveal files/folders; drag and drop files/folders to move them, including dropping onto empty space to move something to the project root; changed files show a colored git status badge (M/A/D/etc.) right in the tree
- **Multi-tab editor** — Monaco-powered syntax highlighting for JS/TS, Python, HTML/CSS, JSON, Markdown, and more
- **Markdown preview** — open a `.md`/`.markdown` file (like this README) and it renders instead of showing raw text: headings, code blocks, tables, blockquotes, lists, images, the works. Hit "✏️ Edit" to switch to the raw source, or "👁 Preview" to switch back — each file remembers which mode you last had it in. External links in the preview open in your system browser.
- **Split editor** (`Ctrl+\`, or the ⊞ button in the titlebar) — click the ⧉ icon on any tab to open it in a second pane side by side, pick a different open file from the dropdown above the split pane any time, and drag the divider to resize. The same file can even be open in both panes at once (two views into one file, like most editors support) — since it's the same underlying model, edits in one pane show up in the other instantly. Markdown files get their own preview toggle in the split pane too, independent of whatever mode the main pane is in.
- **Theme picker** (titlebar button, or the full list under Settings) — four built-in themes (Nexo Dark, Nexo Light, Midnight, High Contrast) plus a **Custom** theme you design yourself: pick a background, text, and accent color in Settings and everything else — panel shades, borders, diff colors, active-row highlighting — is generated automatically to match, live as you pick. **Save named presets** ("Ocean", "Work Mode", whatever) to build a small library and switch between them with one click, instead of re-picking colors every time. Remembers your choice across restarts.
- **Unsaved-change indicators** on tabs, with confirm-before-close/delete, plus an optional **Auto Save** (Settings → Editor)
- **Recent Projects** welcome screen
- **Windows Explorer integration** — right-click any file or folder and pick "Open with Nexo Dev" (or right-click empty space inside a folder for "Open Folder with Nexo Dev"), same as VS Code. Opening a single file also opens its containing folder as the project, so the tree/git panel have full context. If the app's already running, it reuses that window instead of opening a second one. *(Installer build only — see note below.)*
- **Drag and drop from Windows Explorer** — drag a file or folder straight from Explorer into the app window to open it. Dropping a folder opens it as the project; dropping one or more files opens their containing folder as the project and opens each dropped file in a tab.
- **Right-click in the editor** — Monaco's normal Cut/Copy/Paste context menu, plus an explicit **Select All** entry (Ctrl+A always worked as a shortcut; now it's in the menu too).
- **Keyboard shortcuts**: `Ctrl+O` open folder, `Ctrl+N` new file, `Ctrl+S` save, `Ctrl+Shift+S` save as, `Ctrl+W` close tab, `Ctrl+B` toggle sidebar, `` Ctrl+` `` toggle terminal, `Ctrl+\` toggle split editor

### 🔎 Search — find in files
- Type in the search box (`Ctrl+Shift+F`) to search across every file in the open project, live as you type
- Results grouped by file with line numbers and highlighted matches; click any result to jump straight to that line/column in the editor
- Case-sensitive toggle; automatically skips `node_modules`, `.git`, binaries, and anything over 2MB

### 🌿 Git — source control (`Ctrl+Shift+G`)
- **Auto-detects your git repo the moment you open a folder** — no need to click into the Git panel first. It walks up from the opened folder to find the nearest `.git`, so it works even if you open a subfolder of a larger repo. File tree status badges and the change count on the rail icon populate immediately.
- A small red badge on the 🌿 rail icon shows how many files have changes, so you always know at a glance
- **Branch switching** — click "Switch" next to the branch name to see all local branches, check one out, or create a new one on the spot
- **Push / Pull** — buttons right in the branch row, with a live ↑ahead/↓behind indicator against your upstream. First push on a new branch sets the upstream automatically. Credential prompts are disabled (there's no terminal to type into), so an auth failure surfaces as a clear error instead of hanging — set up a credential helper or SSH key beforehand if pushing over HTTPS.
- **Commit history** — a "History" tab alongside "Changes" shows the last 50 commits (hash, author, relative date, message); click any commit to see its full diff in the editor area
- **Merge conflict resolution** — files with unresolved conflicts (from a pull or merge) show up in their own "MERGE CONFLICTS" section with an orange badge, and the rail icon itself turns orange. Click a conflicted file to open it directly in the editor, where a banner appears with **Accept Current**, **Accept Incoming**, and **Accept Both** buttons — each resolves the conflict block nearest your cursor, and "Next ▾" jumps to the next one without resolving. The conflicting regions are also highlighted inline in the editor itself (green for your changes, blue for the incoming ones, with a colored bar in the gutter) so you can see exactly where they are without hunting for `<<<<<<<` markers. Once you're done, hit the ✓ on the file in the Git panel to stage it as resolved.
- **Staged** and **unstaged changes** sections, each file with a status badge and stage/unstage/discard buttons
- Click any changed file to see a colored **diff view** (additions/deletions) right in the editor area
- **Commit box** with a message field and commit button — stages what you've staged and commits with one click
- Requires `git` to be installed and on your PATH (it shells out to the real `git` CLI — no bundled/native git dependency)

### 🌐 Sites — uptime monitoring & SEO audits
- **Add any site by URL** and track it in a persistent list (saved locally, survives restarts)
- **Check Now** — pings the site, records status code, response time, and up/down state
- **Uptime sparkline** — a rolling bar chart of the last checks with a live uptime %
- **Background monitoring** — sites are checked automatically on their own schedule (5m–2h, configurable per site) even while you're working in a different view; a native Windows notification fires the moment a site goes down or comes back up
- **Run SEO Audit** — fetches the page and scores it out of 100 across 10 checks:
  title tag, meta description, H1 usage, image alt-text coverage, canonical tag,
  mobile viewport tag, HTTPS, `robots.txt`, `sitemap.xml`, and response time —
  each with a plain-English explanation of what passed or failed
- **Score history trend** — a small chart of your last 20 audit scores once you've run more than one
- **Open in browser** and **Remove site** actions
- No external APIs or accounts needed — checks and audits run entirely from your machine using plain HTTP requests

### 💻 Terminal (`` Ctrl+` ``)
- A bottom panel for running one-off commands (`npm install`, `git pull`, build scripts, etc.) in the project root, streaming live output
- Command history with ↑/↓ recall, Stop button to kill a running command, resizable by dragging its top edge
- **Why not a full terminal?** A real interactive terminal needs `node-pty`, which requires native compilation — a common source of broken installs on end-user Windows machines without build tools set up. This gives you the 90% use case (run a command, see the output) with zero native dependencies and nothing that can fail to build. Say the word if you'd rather have the full pty-backed terminal and accept that tradeoff.

### ⚙️ Settings
A proper settings page (pinned at the bottom of the icon rail) instead of scattered toggles — everything here is saved to a small local `prefs.json` and applies immediately:
- **Appearance** — theme picker (same options as the titlebar button, including Custom), three color pickers to design your own theme, font size, minimap on/off, word wrap on/off
- **Editor** — Auto Save toggle with a configurable delay
- **Sites Monitor** — default check interval used whenever you add a new site (still changeable per-site afterward)
- **Terminal** — an optional custom shell override (e.g. point it at PowerShell or Git Bash instead of the default Command Prompt)
- **About** — app info

## Performance

The editor was laggy because of a subtle but significant issue: Monaco's background workers (which handle tokenization and language validation off the main thread) were silently failing to start under Electron's `file://` protocol, so all of that work was falling back to running synchronously on the UI thread — every keystroke was blocking on it. Fixed by giving Monaco a small worker bootstrap script so its workers spawn correctly; this was the main fix. On top of that: the minimap now renders blocks instead of character-accurate text (much cheaper), bracket-pair colorization is off by default, and files over 400KB automatically get minimap/folding/link-detection disabled to stay smooth.

## Branding & startup

- The app uses your logo throughout — window/taskbar icon (`renderer/icons/icon.ico`, multi-resolution), the titlebar, both welcome screens, and the splash screen. The color palette (buttons, tabs, cursor, status bar) matches the logo's red/chrome look.
- A splash screen (`renderer/splash.html`) shows immediately on launch instead of a blank/frozen window. The real fix for the slow startup: the editor engine (Monaco) is a few MB spread across many files, and it was previously loading *before* anything else was allowed to render. Now the welcome screen, recent projects, and sites list paint immediately while Monaco loads in the background; if you open a file before it's ready, you'll briefly see "Loading editor…" in the status bar instead of a frozen app. There's also a 6-second safety timeout so the splash always closes even if something goes wrong.

## Requirements

- [Node.js](https://nodejs.org) 18+ (includes npm) installed on Windows
- Windows 10/11 for the packaged app (the build itself can also run cross-platform for dev)

## Setup (run these on your Windows machine)

```bash
cd nexo-dev
npm install
```

**Updating from an older version?** Always re-run `npm install` after replacing the project files with a new version. New versions sometimes add dependencies (v9 added `marked` for markdown preview) — if you copy the new files over an old `node_modules` folder without reinstalling, features that need the new dependency will silently fall back or show an error until you run `npm install` again.

## Run in development

```bash
npm start
```

This launches the app in an Electron window without packaging anything — good for quick iteration.

## Build a real Windows app (.exe)

```bash
npm run dist
```

This uses `electron-builder` to produce:
- an **NSIS installer** (`dist/Nexo Dev Setup <version>.exe`) — the one most users want
- a **portable .exe** (`dist/Nexo Dev <version>.exe`) — no install needed, just run it

Both will appear in the `dist/` folder after the build finishes. The first build downloads Electron's prebuilt binaries, so it needs an internet connection.

**About the "Open with Nexo Dev" right-click menu:** those Explorer context menu entries are registered by the NSIS installer at install time (`build/installer.nsh`), per-user in the registry — no admin rights needed. This means:
- Only the **installer build** gets them; the portable `.exe` has no install step to run the registration, so it won't add context menu entries.
- If you already had an older version installed, running the *new* installer over it re-runs that registration step, so the menu entries will show up after that. Just building the app (`npm run dist`) isn't enough on its own — you need to actually run the resulting installer.
- Uninstalling cleanly removes the registry entries too.

## Project structure

```
nexo-dev/
  main.js          Electron main process — window, menu, filesystem/dialog/git/search/monitoring IPC handlers
  preload.js        Secure bridge exposing window.nexo.* to the renderer
  renderer/
    index.html       App shell (activity rail, sidebar panels, tabs, editor, welcome screens)
    style.css         Dark theme, Nexo-branded red/chrome accent
    renderer.js        All UI logic: file tree, tabs, Monaco wiring, search, git panel, sites panel, modals
    splash.html        Startup splash screen
    icons/             App icon (.ico) + logo PNGs used throughout the UI
  build/
    installer.nsh      Custom NSIS script — registers "Open with Nexo Dev" in Explorer's right-click menu
  package.json       Scripts + electron-builder config
```

## Notes on how it works

- File, git, search, and network operations all run in the **main process**, invoked over IPC from the renderer — this keeps `nodeIntegration` off and `contextIsolation` on, which is the secure Electron pattern.
- The file tree loads lazily: folders are only read when expanded, so it stays fast even on large projects (`node_modules` and `.git` are skipped automatically). Search skips the same directories plus binaries and anything over 2MB.
- Git support shells out to your system's `git` executable via `child_process` rather than bundling a native git library — simpler, more reliable, and it behaves exactly like your normal `git` CLI.
- Monaco is loaded from `node_modules/monaco-editor` directly via its AMD loader — no bundler needed. That's why `asar` packaging is turned off in `package.json` (asar can make Monaco's many small files slow to load); this is a normal, working setup for Electron + Monaco without webpack.
- Markdown preview uses [`marked`](https://github.com/markedjs/marked), loaded the same way — a plain `<script>` tag pointed at its UMD build (`node_modules/marked/lib/marked.umd.js`), no bundler, works fully offline. It's loaded **before** Monaco's loader script on purpose: Monaco's AMD loader defines a global `define()` function, and marked's UMD wrapper checks for that on load — if an AMD loader is already present, marked registers itself as an anonymous AMD module through it instead of setting `window.marked`, which silently breaks the preview. Loading marked first avoids that entirely.
- Recent projects, monitored sites (with check/audit history), and all user settings are stored in small JSON files under Electron's `userData` folder — no database, no extra dependencies beyond Electron, Monaco, and marked.
- The Custom theme only stores three colors (background, text, accent); the rest of the palette (panel shades, borders, text-dim/muted, diff colors, active-row highlight) is derived from those three with simple color math — mixing toward text/black/white by set percentages — rather than asking anyone to hand-pick 20 individual values. It's applied as inline CSS custom properties on `<body>` (which always win over the class-based rules the four built-in themes use), and cleared automatically when switching to one of those.
- The app enforces a single running instance (`app.requestSingleInstanceLock()`). Opening a second file/folder via "Open with Nexo Dev" while the app is already running doesn't launch a second window — Electron hands the new process's arguments to the existing one, which focuses itself and opens the path there instead.

## Adding an app icon

Already wired up — `renderer/icons/icon.ico` (multi-resolution, generated from your logo) is referenced in `package.json` under `build.win.icon` and used for the window/taskbar icon too. Replace that file with a new `.ico` any time you want to update it.

## Ideas for v14

- Full pty-backed interactive terminal (via `node-pty`) if you want to accept the native-build tradeoff
- Multi-window editing

Just say the word and I'll build any of these next.
