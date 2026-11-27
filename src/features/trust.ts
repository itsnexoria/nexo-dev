// Workspace trust (Restricted Mode). Untrusted folders never run project-local tools (node_modules/.bin, venvs, ...).
const trustUi: { trusted: boolean; el: HTMLElement | null } = { trusted: true, el: null };

function paintTrust() {
  if (!trustUi.el) {
    trustUi.el = document.createElement('span');
    trustUi.el.id = 'status-trust';
    trustUi.el.className = 'hidden';
    trustUi.el.style.cursor = 'pointer';
    trustUi.el.title = 'Project tools (language servers, linters, formatters, Python) are disabled. Click to trust this folder.';
    trustUi.el.textContent = '🛡 Restricted Mode';
    trustUi.el.addEventListener('click', () => promptWorkspaceTrust(state.projectRoot));
    document.getElementById('status-right')!.prepend(trustUi.el);
  }
  trustUi.el.classList.toggle('hidden', trustUi.trusted);
}

async function grantWorkspaceTrust(folder: string) {
  await window.nexo.trustGrant(folder);
  trustUi.trusted = true;
  paintTrust();
  hideUpdateToast();
  flashToast('Folder trusted — project tools enabled.');
  try { refreshPyStatus(); } catch { /* optional */ }
  if (state.activeTab) { try { scheduleLint(state.activeTab); } catch { /* optional */ } }
}

function promptWorkspaceTrust(folder: string | null) {
  if (!folder) return;
  showUpdateToast(`Do you trust the authors of "${folder.split(/[\\/]/).pop()}"? Trusting lets Nexo Dev run tools from this folder (language servers, ESLint, Prettier, Python environments).`, [
    { label: 'Trust folder', primary: true, onClick: () => grantWorkspaceTrust(folder) },
    { label: 'Restricted Mode', onClick: hideUpdateToast },
  ]);
}

async function checkWorkspaceTrust(folder: string) {
  try {
    const r = await window.nexo.trustStatus(folder);
    trustUi.trusted = !!(r && r.trusted);
  } catch { trustUi.trusted = true; }
  paintTrust();
  if (!trustUi.trusted) promptWorkspaceTrust(folder);
}

PALETTE_COMMANDS.push({ label: 'Workspace: Trust This Folder', run: () => { if (state.projectRoot) grantWorkspaceTrust(state.projectRoot); } });
PALETTE_COMMANDS.push({ label: 'Workspace: Revoke Trust for This Folder', run: async () => { if (!state.projectRoot) return; await window.nexo.trustRevoke(state.projectRoot); trustUi.trusted = false; paintTrust(); flashToast('Trust revoked. Reopen the folder to apply.'); } });
