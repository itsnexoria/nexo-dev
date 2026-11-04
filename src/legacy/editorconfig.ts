
// ---------------- .editorconfig ----------------
// Indent style/size are applied to the model immediately on open (harmless —
// they don't touch the document's actual content). Trailing-whitespace
// trimming and final-newline enforcement are content changes, so those are
// only applied at save time, in applyEditorConfigNormalization below.
function applyEditorConfigToTab(tab: any) {
  if (!window.nexo.resolveEditorConfig || !state.projectRoot) return;
  window.nexo.resolveEditorConfig(state.projectRoot, tab.path).then((res) => {
    if (!res || !res.ok) return;
    const props = res.props || {};
    tab.editorConfig = props;
    if (!tab.model) return;
    const updates: Record<string, any> = {};
    if (props.indent_style === 'tab') updates.insertSpaces = false;
    else if (props.indent_style === 'space') updates.insertSpaces = true;
    let tabSize = null;
    if (props.indent_size && props.indent_size !== 'tab') {
      const n = parseInt(props.indent_size, 10);
      if (!isNaN(n) && n > 0) tabSize = n;
    } else if (props.tab_width) {
      const n = parseInt(props.tab_width, 10);
      if (!isNaN(n) && n > 0) tabSize = n;
    }
    if (tabSize) updates.tabSize = tabSize;
    if (Object.keys(updates).length) tab.model.updateOptions(updates);
  }).catch(() => {});
}

function applyEditorConfigNormalization(tab: any) {
  const props = tab.editorConfig;
  if (!props || !tab.model) return;
  const model = tab.model;
  let text = model.getValue();
  let changed = false;
  if (props.trim_trailing_whitespace === 'true') {
    const trimmed = text.replace(/[ \t]+(?=\r?\n|$)/g, '');
    if (trimmed !== text) { text = trimmed; changed = true; }
  }
  const eol = model.getEOL();
  if (props.insert_final_newline === 'true') {
    if (text.length && !text.endsWith(eol)) { text += eol; changed = true; }
  } else if (props.insert_final_newline === 'false' && text.endsWith(eol)) {
    text = text.slice(0, -eol.length);
    changed = true;
  }
  if (changed) {
    const fullRange = model.getFullModelRange();
    model.pushEditOperations([], [{ range: fullRange, text }], () => null as any);
  }
}

function fileIcon(name: string, isDir?: boolean, open?: boolean) {
  if (isDir) return open ? '📂' : '📁';
  const ext = name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : '';
  const map: Record<string, string> = {
    js: '🟨', jsx: '🟨', ts: '🔷', tsx: '🔷', json: '🧩', html: '🌐', css: '🎨',
    md: '📝', py: '🐍', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', svg: '🖼️', gif: '🖼️',
    gitignore: '🚫', lock: '🔒',
  };
  return map[ext] || '📄';
}

// ---------------- Binary / image file detection ----------------
// Opening these as text would read them as UTF-8, garble the content in
// Monaco, and — worse — silently corrupt the file if the user hit Ctrl+S
// without noticing. Images get a lightweight preview instead; everything
// else in this list just refuses to open as text.
const IMAGE_FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);
const UNSUPPORTED_BINARY_EXTENSIONS = new Set([
  'exe', 'dll', 'so', 'dylib', 'bin', 'zip', 'gz', 'tar', 'rar', '7z', 'pdf',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  'woff', 'woff2', 'ttf', 'eot', 'otf', 'db', 'sqlite', 'sqlite3',
  'class', 'o', 'pyc', 'node', 'wasm',
]);
function getFileKind(name: string) {
  const ext = name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : '';
  if (IMAGE_FILE_EXTENSIONS.has(ext)) return 'image';
  if (UNSUPPORTED_BINARY_EXTENSIONS.has(ext)) return 'binary';
  return 'text';
}
