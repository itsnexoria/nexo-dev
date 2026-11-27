# Nexo extensions

Drop a folder into `<userData>/extensions/<id>/` (palette: **Extensions: Open Extensions Folder**). The folder name must equal the manifest `id`. See `extensions-sample/hello-nexo`.

## manifest.json
`id` (a-z0-9._-), `name`, `version` (semver), optional `description`, `permissions` (any of `workspace.read`, `workspace.write`, `editor.read`, `editor.write`; default none — API calls that need a permission fail without it), `main` (relative .js), `commands[{id,title}]`, `snippets[{language,prefix,body,description}]`, `themes[{id,name,base:"vs"|"vs-dark",colors,rules}]`.

## Runtime API (inside `main.js`, global `nexo`)
- `nexo.commands.register(id, fn)` — handler for a manifest command (appears in the palette).
- `nexo.statusBar.set(text, tooltip)`
- `nexo.window.notify(text)`
- `nexo.workspace.roots()`, `readFile(path)`, `writeFile(path, content)` — only paths inside open workspace roots.
- `nexo.editor.getText()`, `insertText(text)`

## Permissions
Extensions only get the capabilities they declare. File access is additionally limited to open workspace roots and never reaches `.git`, `.nexo`, `.vscode`, `.husky` or `node_modules`.

## Sandbox
Extensions run in a Web Worker: no DOM, no Node, no `window.nexo` app bridge, and `fetch`/`XMLHttpRequest`/`WebSocket` are unavailable (the app CSP also blocks network). Extensions are still third-party code: install only ones you trust. Manage them with **Extensions: Manage**.
