// Accessibility layer: ARIA roles + roving keyboard navigation, applied by observers so legacy renderers stay untouched.
(function () {
  const $ = (id: string) => document.getElementById(id);
  const roving = (items: HTMLElement[], active: HTMLElement | null) => items.forEach((el) => { el.tabIndex = el === active ? 0 : -1; });

  function decorateTree() {
    const tree = $('file-tree'); if (!tree) return;
    tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', 'Files');
    const rows = Array.from(tree.querySelectorAll<HTMLElement>('.tree-row'));
    for (const r of rows) {
      r.setAttribute('role', 'treeitem');
      const dir = r.dataset.isDir === 'true';
      if (dir) r.setAttribute('aria-expanded', String(!!r.querySelector('.chevron.open')));
      r.setAttribute('aria-label', (r.querySelector('.name')?.textContent || '') + (dir ? ' folder' : ''));
    }
    const current = rows.find((r) => r.tabIndex === 0) || rows.find((r) => r.classList.contains('active')) || rows[0] || null;
    roving(rows, current);
  }
  function decorateTabs() {
    const bar = $('tabbar'); if (!bar) return;
    bar.setAttribute('role', 'tablist'); bar.setAttribute('aria-label', 'Open editors');
    const tabs = Array.from(bar.querySelectorAll<HTMLElement>('.tab'));
    for (const t of tabs) { t.setAttribute('role', 'tab'); t.setAttribute('aria-selected', String(t.classList.contains('active'))); }
    roving(tabs, tabs.find((t) => t.classList.contains('active')) || tabs[0] || null);
  }
  function decoratePalette() {
    const list = $('palette-list'); if (!list) return;
    list.setAttribute('role', 'listbox');
    list.querySelectorAll<HTMLElement>('.palette-item').forEach((el) => { el.setAttribute('role', 'option'); el.setAttribute('aria-selected', String(el.classList.contains('active'))); });
    $('palette-input')?.setAttribute('aria-label', 'Search files or commands');
  }
  const observe = (id: string, fn: () => void, attrs = false) => {
    const el = $(id); if (!el) return; fn();
    new MutationObserver(() => fn()).observe(el, { childList: true, subtree: true, attributes: attrs, attributeFilter: attrs ? ['class'] : undefined });
  };

  function move(items: HTMLElement[], from: HTMLElement, delta: number) {
    const i = items.indexOf(from); const next = items[Math.max(0, Math.min(items.length - 1, i + delta))];
    if (next) { roving(items, next); next.focus(); }
  }
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement; if (!t || !t.closest) return;
    const row = t.closest<HTMLElement>('.tree-row');
    if (row && $('file-tree')?.contains(row)) {
      const rows = Array.from($('file-tree')!.querySelectorAll<HTMLElement>('.tree-row'));
      if (e.key === 'ArrowDown') { e.preventDefault(); move(rows, row, 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(rows, row, -1); }
      else if (e.key === 'Home') { e.preventDefault(); move(rows, row, -rows.length); }
      else if (e.key === 'End') { e.preventDefault(); move(rows, row, rows.length); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
      else if (e.key === 'ArrowRight' && row.getAttribute('aria-expanded') === 'false') { e.preventDefault(); row.click(); }
      else if (e.key === 'ArrowLeft' && row.getAttribute('aria-expanded') === 'true') { e.preventDefault(); row.click(); }
      return;
    }
    const tab = t.closest<HTMLElement>('.tab');
    if (tab && $('tabbar')?.contains(tab)) {
      const tabs = Array.from($('tabbar')!.querySelectorAll<HTMLElement>('.tab'));
      if (e.key === 'ArrowRight') { e.preventDefault(); move(tabs, tab, 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); move(tabs, tab, -1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tab.click(); }
    }
  });
  $('file-tree')?.addEventListener('focusin', (e) => { const r = (e.target as HTMLElement).closest<HTMLElement>('.tree-row'); if (r) roving(Array.from($('file-tree')!.querySelectorAll<HTMLElement>('.tree-row')), r); });

  observe('file-tree', decorateTree); observe('tabbar', decorateTabs, true); observe('palette-list', decoratePalette, true);
  for (const [id, label] of [['toast', ''], ['flash-toast', '']] as const) { const el = $(id); if (el) { el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); } void label; }
  document.querySelectorAll<HTMLElement>('#activitybar button').forEach((b) => { if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', b.title || b.id.replace(/^rail-/, '')); });
  window.nexoA11y = { decorateTree, decorateTabs };
})();
