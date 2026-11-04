
// ---------------- Split editor pane ----------------
function ensureSplitEditor() {
  if (splitEditor) return;
  splitEditor = monaco.editor.create(document.getElementById('editor-container-split'), {
    automaticLayout: true,
    fontFamily: "'Cascadia Code', Consolas, 'JetBrains Mono', monospace",
    fontSize: uiState.fontSize,
    theme: uiState.theme === 'custom' ? 'nexo-custom' : monacoThemeId(uiState.theme),
    model: null,
    minimap: { enabled: uiState.minimap, renderCharacters: false, maxColumn: 80 },
    wordWrap: uiState.wordWrap ? 'on' : 'off',
    bracketPairColorization: { enabled: uiState.bracketGuides },
    guides: { indentation: uiState.bracketGuides, bracketPairs: uiState.bracketGuides },
    smoothScrolling: false,
    renderWhitespace: 'selection',
    occurrencesHighlight: 'off',
    wordBasedSuggestions: 'currentDocument',
    stickyScroll: { enabled: true },
    mouseWheelZoom: true,
  });
  addSelectAllAction(splitEditor);
}

function updateSplitTabOptions() {
  const select = document.getElementById('split-tab-select');
  select!.innerHTML = '';
  for (const tab of state.openTabs) {
    if (tab.isImage) continue; // images can't be shown in the split pane
    const opt = document.createElement('option');
    opt.value = tab.path;
    opt.textContent = tab.name;
    if (tab.path === splitState.tabPath) opt.selected = true;
    select!.appendChild(opt);
  }
}

function renderSplitMarkdownPreview(tab: any) {
  const box = document.getElementById('split-markdown-preview-content');
  try {
    if (window.marked) {
      const raw = marked.parse(tab.model.getValue());
      box!.innerHTML = window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
    } else {
      box!.innerHTML = '<p>Markdown renderer not available. Run <code>npm install</code> and restart.</p>';
    }
  } catch (err) {
    box!.innerHTML = `<p>Could not render markdown: ${escapeHtml(err.message)}</p>`;
  }
}

function updateSplitDisplay() {
  const tab = state.openTabs.find((t) => t.path === splitState.tabPath);
  const toggleBtn = document.getElementById('split-md-toggle-btn');
  const previewPane = document.getElementById('split-markdown-preview');
  if (!tab || !tab.isMarkdown) {
    toggleBtn!.classList.add('hidden');
    previewPane!.classList.remove('active');
    return;
  }
  toggleBtn!.classList.remove('hidden');
  toggleBtn!.classList.toggle('on', splitState.mdMode === 'preview');
  toggleBtn!.textContent = splitState.mdMode === 'preview' ? '✏️ Edit' : '👁 Preview';
  if (splitState.mdMode === 'preview') {
    renderSplitMarkdownPreview(tab);
    previewPane!.classList.add('active');
  } else {
    previewPane!.classList.remove('active');
  }
}

document.getElementById('split-md-toggle-btn')!.addEventListener('click', () => {
  splitState.mdMode = splitState.mdMode === 'preview' ? 'edit' : 'preview';
  updateSplitDisplay();
});

async function showInSplit(filePath: any) {
  if (!monacoLoaded) await monacoReadyPromise;
  const tab = state.openTabs.find((t) => t.path === filePath);
  if (!tab || tab.isImage) return;
  ensureSplitEditor();
  splitState.tabPath = filePath;
  splitState.mdMode = tab.isMarkdown ? 'preview' : null;
  splitEditor.setModel(tab.model);
  document.getElementById('editor-pane-split')!.classList.add('active');
  document.getElementById('split-resizer')!.classList.add('active');
  splitState.visible = true;
  updateSplitTabOptions();
  updateSplitDisplay();
  if (editor) editor.layout();
}

function hideSplit() {
  splitState.visible = false;
  splitState.tabPath = null;
  splitState.mdMode = null;
  document.getElementById('editor-pane-split')!.classList.remove('active');
  document.getElementById('split-resizer')!.classList.remove('active');
  document.getElementById('editor-pane-split')!.style.width = '';
  document.getElementById('split-markdown-preview')!.classList.remove('active');
  if (splitEditor) splitEditor.setModel(null);
  if (editor) editor.layout();
}

async function openInSplit(filePath: any) {
  if (splitState.visible && splitState.tabPath === filePath) { hideSplit(); return; }
  await showInSplit(filePath);
}

function toggleSplit() {
  if (splitState.visible) { hideSplit(); return; }
  const target = splitState.tabPath && state.openTabs.some((t) => t.path === splitState.tabPath)
    ? splitState.tabPath
    : state.activeTab;
  if (!target) return; // nothing open to show
  showInSplit(target);
}

document.getElementById('split-tab-select')!.addEventListener('change', (e) => showInSplit((e.target as HTMLSelectElement).value));
document.getElementById('split-close-btn')!.addEventListener('click', hideSplit);
document.getElementById('btn-toggle-split')!.addEventListener('click', toggleSplit);

(function setupSplitResizer() {
  const resizer = document.getElementById('split-resizer');
  const pane = document.getElementById('editor-pane-split');
  let dragging = false;
  resizer!.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'col-resize'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const areaRect = document.getElementById('editor-area')!.getBoundingClientRect();
    const w = Math.max(220, Math.min(areaRect.width * 0.75, areaRect.right - e.clientX));
    pane!.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    if (editor) editor.layout();
    if (splitEditor) splitEditor.layout();
  });
})();

