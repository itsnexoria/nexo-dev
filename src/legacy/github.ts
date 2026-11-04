
// ---------------- GitHub PRs / Issues panel ----------------
let githubPanelState: any = { subtab: 'pulls', pulls: null, issues: null, releases: null, pullsError: null, issuesError: null, releasesError: null, error: null, loading: false };

async function loadGithubPanel() {
  const status = await window.nexo.hasGithubToken();
  if (!status.hasToken) {
    githubPanelState = { ...githubPanelState, pulls: null, issues: null, releases: null, error: 'not-connected', loading: false };
    renderGithubPanel();
    return;
  }
  if (!state.projectRoot) {
    githubPanelState = { ...githubPanelState, pulls: null, issues: null, releases: null, error: 'no-project', loading: false };
    renderGithubPanel();
    return;
  }
  githubPanelState.loading = true;
  githubPanelState.error = null;
  renderGithubPanel();
  const [pullsRes, issuesRes, releasesRes] = await Promise.all([
    window.nexo.listGithubPulls(state.projectRoot),
    window.nexo.listGithubIssues(state.projectRoot),
    window.nexo.listGithubReleases(state.projectRoot),
  ]);
  githubPanelState.loading = false;
  if (!pullsRes.ok && !issuesRes.ok && !releasesRes.ok) {
    githubPanelState.error = pullsRes.error || issuesRes.error || releasesRes.error;
  } else {
    githubPanelState.pulls = pullsRes.ok ? pullsRes.pulls : [];
    githubPanelState.issues = issuesRes.ok ? issuesRes.issues : [];
    githubPanelState.releases = releasesRes.ok ? releasesRes.releases : [];
    githubPanelState.pullsError = pullsRes.ok ? null : pullsRes.error;
    githubPanelState.issuesError = issuesRes.ok ? null : issuesRes.error;
    githubPanelState.releasesError = releasesRes.ok ? null : releasesRes.error;
  }
  renderGithubPanel();
}

function renderGithubPanel() {
  document.getElementById('github-tab-pulls')!.classList.toggle('active', githubPanelState.subtab === 'pulls');
  document.getElementById('github-tab-issues')!.classList.toggle('active', githubPanelState.subtab === 'issues');
  document.getElementById('github-tab-releases')!.classList.toggle('active', githubPanelState.subtab === 'releases');
  const body = document.getElementById('github-body');

  if (githubPanelState.error === 'not-connected') {
    body!.innerHTML = '<div class="git-empty">Connect a GitHub token in Settings to see PRs, issues &amp; releases.</div>';
    return;
  }
  if (githubPanelState.error === 'no-project') {
    body!.innerHTML = '<div class="git-empty">Open a project first.</div>';
    return;
  }
  if (githubPanelState.loading) {
    body!.innerHTML = '<div class="git-empty">Loading…</div>';
    return;
  }
  if (githubPanelState.error) {
    body!.innerHTML = `<div class="git-empty">${escapeHtml(githubPanelState.error)}</div>`;
    return;
  }

  if (githubPanelState.subtab === 'releases') {
    renderReleasesSubtab(body);
    return;
  }

  const items = githubPanelState.subtab === 'pulls' ? githubPanelState.pulls : githubPanelState.issues;
  const itemsError = githubPanelState.subtab === 'pulls' ? githubPanelState.pullsError : githubPanelState.issuesError;
  if (itemsError) { body!.innerHTML = `<div class="git-empty">${escapeHtml(itemsError)}</div>`; return; }
  if (!items || !items.length) {
    body!.innerHTML = `<div class="git-empty">No open ${githubPanelState.subtab === 'pulls' ? 'pull requests' : 'issues'}.</div>`;
    return;
  }
  body!.innerHTML = items.map((it: any) => `
    <div class="gh-item-row" data-url="${escapeHtml(it.url)}">
      <div class="gh-item-title">${it.draft ? '<span class="gh-draft-badge">Draft</span>' : ''}${escapeHtml(it.title)}</div>
      <div class="gh-item-meta">#${it.number} · ${escapeHtml(it.author)}${githubPanelState.subtab === 'pulls' ? ` · ${escapeHtml(it.branch)}` : ''}</div>
      ${it.labels && it.labels.length ? `<div class="gh-item-labels">${it.labels.map((l: any) => `<span class="gh-label">${escapeHtml(l)}</span>`).join('')}</div>` : ''}
    </div>
  `).join('');
  body!.querySelectorAll('.gh-item-row').forEach((row) => {
    row.addEventListener('click', () => window.nexo.openExternal((row as HTMLElement).dataset.url));
  });
}

function renderReleasesSubtab(body: any) {
  if (githubPanelState.releasesError) {
    body.innerHTML = `<div class="git-empty">${escapeHtml(githubPanelState.releasesError)}</div>`;
    return;
  }
  const releases = githubPanelState.releases || [];
  const listHtml = releases.length
    ? releases.map((r: any) => `
      <div class="gh-item-row" data-url="${escapeHtml(r.url)}">
        <div class="gh-item-title">
          ${r.draft ? '<span class="gh-draft-badge">Draft</span>' : ''}${r.prerelease ? '<span class="gh-draft-badge">Pre-release</span>' : ''}${escapeHtml(r.name)}
        </div>
        <div class="gh-item-meta">${escapeHtml(r.tagName)}${r.publishedAt ? ` · ${new Date(r.publishedAt).toLocaleDateString()}` : ''}</div>
      </div>`).join('')
    : '<div class="git-empty">No releases yet.</div>';
  body.innerHTML = `<div class="gh-releases-actions"><button class="tbtn" id="gh-new-release-btn">+ New Release</button></div>${listHtml}`;
  body.querySelectorAll('.gh-item-row').forEach((row: any) => {
    row.addEventListener('click', () => window.nexo.openExternal(row.dataset.url));
  });
  document.getElementById('gh-new-release-btn')!.addEventListener('click', openCreateReleaseForm);
}

function openCreateReleaseForm() {
  showModal({
    title: 'Create GitHub Release',
    fields: [
      { id: 'tagName', placeholder: 'v1.0.0' },
      { id: 'name', placeholder: 'Release title (optional — defaults to tag)', required: false },
      { id: 'body', placeholder: 'Release notes (optional)', required: false },
    ],
    confirmLabel: 'Next',
    onConfirm: ({ tagName, name, body }: any) => {
      if (!tagName.trim()) return 'Tag name is required.';
      setTimeout(() => continueCreateReleaseFlow(tagName.trim(), name.trim(), body), 50);
      return null;
    },
  });
}

async function continueCreateReleaseFlow(tagName: any, name: any, body: any) {
  const draft = confirm('Save as a draft (not published yet)?\n\nOK = draft, Cancel = publish immediately');
  let prerelease = false;
  if (!draft) prerelease = confirm('Mark this as a pre-release?\n\nOK = pre-release, Cancel = full release');
  showUpdateToast('Creating release…', []);
  try {
    const res = await window.nexo.createGithubRelease(state.projectRoot, {
      tagName, name, body, draft, prerelease, targetCommitish: gitState.branch || undefined,
    });
    if (!res.ok) { alert(`Could not create release:\n${res.error}`); return; }
    if (document.getElementById('panel-github')!.classList.contains('active')) loadGithubPanel();
  } finally {
    hideUpdateToast();
  }
}

// ---------------- Cloudflare Pages deploy scaffolding ----------------
function handleSetupCloudflareDeploy() {
  window.nexo.hasGithubToken().then((status) => {
    if (!status.hasToken) { alert("Connect a GitHub token in Settings first — it's needed to set the deploy secrets on your repo."); return; }
    if (!state.projectRoot) { alert('Open a project first.'); return; }
    showModal({
      title: 'Set Up Cloudflare Pages Deploy',
      fields: [
        { id: 'projectName', label: 'Cloudflare Pages project name', placeholder: 'my-site' },
        { id: 'buildDir', label: 'Build output directory', placeholder: 'dist (use . for a static site with no build step)' },
        { id: 'apiToken', label: 'Cloudflare API Token', placeholder: 'Paste your Cloudflare API token', type: 'password' },
        { id: 'accountId', label: 'Cloudflare Account ID', placeholder: 'Found in your Cloudflare dashboard sidebar' },
      ],
      confirmLabel: 'Set Up',
      onConfirm: ({ projectName, buildDir, apiToken, accountId }: any): any => {
        setTimeout(() => continueCloudflareDeploySetup(projectName, buildDir, apiToken, accountId), 50);
        return null;
      },
    });
  });
}

function buildCloudflarePagesWorkflowYaml(projectName: any, buildDir: any, branch: any) {
  return `name: Deploy to Cloudflare Pages

on:
  push:
    branches: [${branch}]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      deployments: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: |
          if [ -f package-lock.json ]; then npm ci; \\
          elif [ -f package.json ]; then npm install; \\
          else echo "No package.json — nothing to install."; fi

      - name: Build
        run: npm run build --if-present

      - name: Deploy to Cloudflare Pages
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy ${buildDir} --project-name=${projectName}
`;
}

async function continueCloudflareDeploySetup(projectName: any, buildDir: any, apiToken: any, accountId: any) {
  showUpdateToast('Setting up Cloudflare Pages deploy…', []);
  try {
    const secretsToSet = [['CLOUDFLARE_API_TOKEN', apiToken], ['CLOUDFLARE_ACCOUNT_ID', accountId]];
    for (const [name, value] of secretsToSet) {
      const res = await window.nexo.setGithubSecret(state.projectRoot, name, value);
      if (!res.ok) {
        alert(`Could not set the ${name} secret on GitHub:\n${res.error}\n\nMake sure your GitHub token has permission to manage Actions secrets for this repo (classic tokens need the full "repo" scope).`);
        return;
      }
    }
    const branch = gitState.branch || 'main';
    const yaml = buildCloudflarePagesWorkflowYaml(projectName, buildDir, branch);
    const sep = state.projectRoot!.includes('\\') ? '\\' : '/';
    const workflowPath = `${state.projectRoot}${sep}.github${sep}workflows${sep}deploy-cloudflare-pages.yml`;
    const writeRes = await window.nexo.writeFile(workflowPath, yaml);
    if (!writeRes.ok) { alert(`Secrets were set on GitHub, but the workflow file couldn't be written:\n${writeRes.error}`); return; }
    renderTree();
    const openNow = confirm(`Done! Created .github/workflows/deploy-cloudflare-pages.yml and set your Cloudflare secrets on GitHub.\n\nCommit and push this file to enable auto-deploys on every push to "${branch}".\n\nOpen the workflow file now?`);
    if (openNow) openFile(workflowPath);
  } finally {
    hideUpdateToast();
  }
}

document.getElementById('github-tab-pulls')!.addEventListener('click', () => { githubPanelState.subtab = 'pulls'; renderGithubPanel(); });
document.getElementById('github-tab-issues')!.addEventListener('click', () => { githubPanelState.subtab = 'issues'; renderGithubPanel(); });
document.getElementById('github-tab-releases')!.addEventListener('click', () => { githubPanelState.subtab = 'releases'; renderGithubPanel(); });
document.getElementById('btn-github-refresh')!.addEventListener('click', loadGithubPanel);
document.getElementById('btn-github-new-repo')!.addEventListener('click', handleCreateGithubRepo);
document.getElementById('btn-cloudflare-deploy')!.addEventListener('click', handleSetupCloudflareDeploy);
