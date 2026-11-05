'use strict';
// Git (shells out to the system `git`) + GitHub API IPC: status/diff/stage/commit/branches/push/pull/clone,
// releases, repos, pulls, issues, secrets. The GitHub token is encrypted at rest with the OS keychain.
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFile } = require('child_process');
const sodium = require('libsodium-wrappers');

function register({ ipcMain, app, safeStorage, addRecent }) {
  // ---------- Git integration (shells out to the system `git`, no native deps) ----------
  // Output parsers (status/blame porcelain, remote URL parsing) live in
  // lib/git-parse.js (kept dependency-free from Electron so they're
  // unit-testable independent of a real git executable).
  const { parsePorcelainStatus, parseBlamePorcelain, parseGithubOwnerRepo } = require('./git-parse');
  function runGit(args, cwd, opts = {}) {
    return new Promise((resolve) => {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      // Keep the GitHub token out of argv (visible in process listings): move our
      // `-c http.<url>.extraheader=...` pair into GIT_CONFIG_* environment variables.
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '-c' && args[i + 1].startsWith('http.https://github.com/.extraheader=')) {
          const [k, ...v] = args[i + 1].split('=');
          const n = parseInt(env.GIT_CONFIG_COUNT || '0', 10) || 0;
          env[`GIT_CONFIG_KEY_${n}`] = k; env[`GIT_CONFIG_VALUE_${n}`] = v.join('=');
          env.GIT_CONFIG_COUNT = String(n + 1);
          args = [...args.slice(0, i), ...args.slice(i + 2)];
          i--;
        }
      }
      if (opts.authSensitive) {
        // GIT_TERMINAL_PROMPT only suppresses git's own text-based prompt —
        // it does nothing to stop a GUI credential helper (e.g. Windows' Git
        // Credential Manager) from popping up its own window, which is easy
        // to miss behind the app and looks exactly like a silent hang.
        // GIT_ASKPASS/SSH_ASKPASS point at a command that returns nothing,
        // so any credential request fails immediately instead of waiting on
        // a prompt nobody's going to see. Cached credentials (a helper that
        // already has a valid token) are unaffected — this only kicks in
        // when git would otherwise need to *ask*.
        const noPrompt = process.platform === 'win32' ? 'cmd.exe /c exit 1' : 'true';
        env.GIT_ASKPASS = noPrompt;
        env.SSH_ASKPASS = noPrompt;
        env.SSH_ASKPASS_REQUIRE = 'force';
      }
      execFile('git', args, {
        cwd,
        maxBuffer: 20 * 1024 * 1024,
        timeout: opts.timeoutMs || 0, // 0 = no timeout
        env,
      }, (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || (err ? err.message : '') });
      });
    });
  }

  const { isSafeGitRef } = require('./validate');

  async function getGitRoot(startPath) {
    const res = await runGit(['rev-parse', '--show-toplevel'], startPath);
    if (!res.ok) return null;
    return res.stdout.trim().replace(/\//g, path.sep);
  }

  ipcMain.handle('git:clone', async (evt, url, destParentDir) => {
    if (typeof url !== 'string') return { ok: false, error: 'Invalid repository URL.' };
    let name = (url.trim().replace(/[\/\\]+$/, '').split(/[\/:]/).pop() || 'repository').replace(/\.git$/i, '');
    name = name.replace(/[<>:"|?*\\/]/g, '').trim();
    if (!name || name === '.' || name === '..') name = 'repository';
    let destDir = path.join(destParentDir, name);
    let suffix = 1;
    while (fs.existsSync(destDir)) {
      destDir = path.join(destParentDir, `${name}-${suffix}`);
      suffix++;
    }
    const trimmedUrl = url.trim();
    if (!trimmedUrl || trimmedUrl.startsWith('-')) return { ok: false, error: 'Invalid repository URL.' };
    const authArgs = /^https:\/\/(www\.)?github\.com\//i.test(trimmedUrl) ? githubAuthHeaderArgs(readGithubToken()) : [];
    const res = await runGit([...authArgs, 'clone', '--', trimmedUrl, destDir], destParentDir, { authSensitive: true, timeoutMs: 300000 });
    if (!res.ok) return { ok: false, error: res.stderr || res.stdout || 'Clone failed.' };
    const recent = addRecent(destDir);
    return { ok: true, path: destDir, recent };
  });
  // ---------- IPC: git ----------
  // ---------- GitHub API integration ----------
  // The token is encrypted at rest with the OS keychain (safeStorage) rather
  // than living in plain text in prefs.json — it's a real credential, not a
  // UI preference.
  function githubTokenPath() { return path.join(app.getPath('userData'), 'github-token.enc'); }

  function saveGithubToken(token) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level credential encryption is unavailable on this system, so the token cannot be stored securely.');
    }
    fs.writeFileSync(githubTokenPath(), safeStorage.encryptString(token));
  }

  function readGithubToken() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const enc = fs.readFileSync(githubTokenPath());
      return safeStorage.decryptString(enc);
    } catch {
      return null;
    }
  }

  function clearGithubToken() {
    try { fs.unlinkSync(githubTokenPath()); } catch { /* already gone */ }
  }

  function githubApiRequest(method, urlPath, body, tokenOverride) {
    return new Promise((resolve) => {
      const token = tokenOverride || readGithubToken();
      if (!token) { resolve({ ok: false, status: 0, error: 'No GitHub token saved. Add one in Settings.' }); return; }
      const data = body ? JSON.stringify(body) : null;
      const req = https.request({
        hostname: 'api.github.com',
        path: urlPath,
        method,
        headers: {
          'User-Agent': 'Nexo-Dev',
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
        timeout: 15000,
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { /* non-JSON body */ }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, status: res.statusCode, data: json });
          else resolve({ ok: false, status: res.statusCode, error: (json && json.message) || `GitHub API error ${res.statusCode}` });
        });
      });
      req.on('timeout', () => req.destroy(new Error('Request to GitHub timed out.')));
      req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
      if (data) req.write(data);
      req.end();
    });
  }

  // Only inject the token for github.com HTTPS remotes — never for SSH remotes
  // (which use your existing SSH keys) or other hosts (self-hosted GitLab,
  // Bitbucket, etc.) where this PAT has no business being sent.
  function githubAuthHeaderArgs(token) {
    if (!token) return [];
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    // Scoped via -c to this single invocation — never written to .git/config,
    // never appears in `git remote -v`, and doesn't touch the stored remote URL.
    return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
  }

  async function githubAuthArgsForRemote(root) {
    const token = readGithubToken();
    if (!token) return [];
    const remoteRes = await runGit(['remote', 'get-url', 'origin'], root);
    if (!remoteRes.ok || !/^https:\/\/(www\.)?github\.com\//i.test(remoteRes.stdout.trim())) return [];
    // git's extraHeader config is multi-valued — if this repo already has a
    // leftover http.extraheader entry from something else (an old manual PAT
    // setup, GitHub Desktop, gh CLI, whatever), our own -c-scoped header below
    // gets sent ALONGSIDE it rather than replacing it, so the request ends up
    // with two Authorization headers and GitHub can reject or misbehave on
    // that. Clearing any existing entry first (silently — it's fine if there
    // isn't one) keeps this repo's git config from fighting with our own auth.
    await runGit(['config', '--unset-all', 'http.https://github.com/.extraheader'], root);
    return githubAuthHeaderArgs(token);
  }

  async function getGithubOwnerRepo(root) {
    const res = await runGit(['remote', 'get-url', 'origin'], root);
    if (!res.ok) return null;
    return parseGithubOwnerRepo(res.stdout);
  }

  ipcMain.handle('github:set-token', async (evt, token) => {
    const trimmed = (token || '').trim();
    if (!trimmed) return { ok: false, error: 'Token cannot be empty.' };
    const res = await githubApiRequest('GET', '/user', null, trimmed);
    if (!res.ok) return { ok: false, error: res.status === 401 ? 'That token was rejected by GitHub — check it was copied correctly and has not expired.' : res.error };
    try {
      saveGithubToken(trimmed);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    return { ok: true, user: { login: res.data.login, avatar: res.data.avatar_url, name: res.data.name } };
  });

  ipcMain.handle('github:get-user', async () => {
    if (!readGithubToken()) return { ok: false, error: 'No token saved.' };
    const res = await githubApiRequest('GET', '/user');
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, user: { login: res.data.login, avatar: res.data.avatar_url, name: res.data.name } };
  });

  ipcMain.handle('github:clear-token', () => { clearGithubToken(); return { ok: true }; });
  ipcMain.handle('github:has-token', () => ({ hasToken: !!readGithubToken() }));

  ipcMain.handle('github:list-releases', async (evt, projectRoot) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const or = await getGithubOwnerRepo(root);
    if (!or) return { ok: false, error: 'The origin remote is not a GitHub URL.' };
    const res = await githubApiRequest('GET', `/repos/${or.owner}/${or.repo}/releases?per_page=50`);
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      releases: res.data.map((r) => ({
        id: r.id, tagName: r.tag_name, name: r.name || r.tag_name, body: r.body || '',
        draft: r.draft, prerelease: r.prerelease, url: r.html_url, publishedAt: r.published_at || r.created_at,
      })),
    };
  });

  ipcMain.handle('github:create-release', async (evt, projectRoot, opts) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const or = await getGithubOwnerRepo(root);
    if (!or) return { ok: false, error: 'The origin remote is not a GitHub URL.' };
    if (!opts || !opts.tagName || !opts.tagName.trim()) return { ok: false, error: 'Tag name is required.' };
    const body = {
      tag_name: opts.tagName.trim(),
      name: (opts.name || opts.tagName).trim(),
      body: opts.body || '',
      draft: !!opts.draft,
      prerelease: !!opts.prerelease,
    };
    // If the tag doesn't exist yet, GitHub creates it automatically pointed at
    // this commitish — same behavior as typing a new tag in the web UI.
    if (opts.targetCommitish) body.target_commitish = opts.targetCommitish;
    const res = await githubApiRequest('POST', `/repos/${or.owner}/${or.repo}/releases`, body);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, release: { url: res.data.html_url, tagName: res.data.tag_name } };
  });

  // Encrypts a value for a GitHub Actions secret using libsodium's sealed-box
  // scheme against the repo's public key — this is GitHub's documented
  // requirement for the Actions secrets API (crypto_box_seal), not a arbitrary
  // choice. The plaintext secret is never sent to GitHub or written to disk —
  // only the sealed ciphertext leaves this function.
  async function encryptSecretForGithub(publicKeyBase64, secretValue) {
    await sodium.ready;
    const keyBytes = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
    const messageBytes = sodium.from_string(secretValue);
    const sealedBytes = sodium.crypto_box_seal(messageBytes, keyBytes);
    return sodium.to_base64(sealedBytes, sodium.base64_variants.ORIGINAL);
  }

  ipcMain.handle('github:set-secret', async (evt, projectRoot, secretName, secretValue) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const or = await getGithubOwnerRepo(root);
    if (!or) return { ok: false, error: 'The origin remote is not a GitHub URL.' };
    const keyRes = await githubApiRequest('GET', `/repos/${or.owner}/${or.repo}/actions/secrets/public-key`);
    if (!keyRes.ok) return { ok: false, error: keyRes.error };
    let encrypted;
    try {
      encrypted = await encryptSecretForGithub(keyRes.data.key, secretValue);
    } catch (err) {
      return { ok: false, error: `Could not encrypt secret: ${err.message}` };
    }
    const putRes = await githubApiRequest('PUT', `/repos/${or.owner}/${or.repo}/actions/secrets/${encodeURIComponent(secretName)}`, {
      encrypted_value: encrypted,
      key_id: keyRes.data.key_id,
    });
    if (!putRes.ok) return { ok: false, error: putRes.error };
    return { ok: true };
  });

  ipcMain.handle('github:list-repos', async () => {
    const res = await githubApiRequest('GET', '/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member');
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      repos: res.data.map((r) => ({
        fullName: r.full_name, cloneUrl: r.clone_url, private: r.private,
        description: r.description, updatedAt: r.updated_at,
      })),
    };
  });

  ipcMain.handle('github:create-repo', async (evt, { name, description, isPrivate }) => {
    if (!name || !name.trim()) return { ok: false, error: 'Repository name is required.' };
    const res = await githubApiRequest('POST', '/user/repos', { name: name.trim(), description: description || '', private: !!isPrivate });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, repo: { fullName: res.data.full_name, cloneUrl: res.data.clone_url, htmlUrl: res.data.html_url } };
  });

  ipcMain.handle('github:list-pulls', async (evt, projectRoot) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const or = await getGithubOwnerRepo(root);
    if (!or) return { ok: false, error: 'The origin remote is not a GitHub URL.' };
    const res = await githubApiRequest('GET', `/repos/${or.owner}/${or.repo}/pulls?state=open&per_page=50`);
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      pulls: res.data.map((p) => ({
        number: p.number, title: p.title, author: p.user.login, url: p.html_url,
        draft: p.draft, branch: p.head.ref, updatedAt: p.updated_at,
      })),
    };
  });

  ipcMain.handle('github:list-issues', async (evt, projectRoot) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const or = await getGithubOwnerRepo(root);
    if (!or) return { ok: false, error: 'The origin remote is not a GitHub URL.' };
    const res = await githubApiRequest('GET', `/repos/${or.owner}/${or.repo}/issues?state=open&per_page=50`);
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      // The issues endpoint also returns PRs — filter those out, they're covered by list-pulls.
      issues: res.data.filter((i) => !i.pull_request).map((i) => ({
        number: i.number, title: i.title, author: i.user.login, url: i.html_url,
        updatedAt: i.updated_at, labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
      })),
    };
  });

  ipcMain.handle('git:status', async (evt, projectRoot) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const res = await runGit(['status', '--porcelain'], root);
    if (!res.ok) return { ok: false, error: res.stderr || 'git status failed.' };
    const { staged, unstaged, conflicts } = parsePorcelainStatus(res.stdout);
    const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    return { ok: true, root, branch: branchRes.ok ? branchRes.stdout.trim() : '', staged, unstaged, conflicts };
  });

  // Parses `git blame --line-porcelain` output (see lib/git-parse.js for the
  // implementation and the note on why metadata is cached by hash).
  ipcMain.handle('git:blame', async (evt, projectRoot, filePath) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const res = await runGit(['blame', '--line-porcelain', '--', filePath], root, { timeoutMs: 15000 });
    if (!res.ok) return { ok: false, error: res.stderr || 'git blame failed.' }; // e.g. untracked/new file — not an error worth surfacing
    return { ok: true, lines: parseBlamePorcelain(res.stdout) };
  });

  ipcMain.handle('git:diff', async (evt, projectRoot, relPath, staged) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const args = staged ? ['diff', '--cached', '--', relPath] : ['diff', '--', relPath];
    const res = await runGit(args, root);
    if (!res.ok && res.stderr) return { ok: false, error: res.stderr };
    let diff = res.stdout;
    if (!diff && !staged) {
      // likely an untracked file — show its full contents as an "all added" diff
      const untrackedRes = await runGit(['diff', '--no-index', '--', '/dev/null', relPath], root);
      diff = untrackedRes.stdout || '';
    }
    return { ok: true, diff };
  });

  ipcMain.handle('git:stage', async (evt, projectRoot, relPath) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const res = await runGit(['add', '--', relPath], root);
    return { ok: res.ok, error: res.ok ? null : res.stderr };
  });

  ipcMain.handle('git:stage-all', async (evt, projectRoot) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const res = await runGit(['add', '-A'], root);
    return { ok: res.ok, error: res.ok ? null : res.stderr };
  });

  ipcMain.handle('git:unstage', async (evt, projectRoot, relPath) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const res = await runGit(['reset', '--', relPath], root);
    return { ok: res.ok, error: res.ok ? null : res.stderr };
  });

  ipcMain.handle('git:unstage-all', async (evt, projectRoot) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const res = await runGit(['reset'], root);
    return { ok: res.ok, error: res.ok ? null : res.stderr };
  });

  ipcMain.handle('git:discard', async (evt, projectRoot, relPath) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const res = await runGit(['checkout', '--', relPath], root);
    return { ok: res.ok, error: res.ok ? null : res.stderr };
  });

  ipcMain.handle('git:commit', async (evt, projectRoot, message) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    if (!message || !message.trim()) return { ok: false, error: 'Commit message cannot be empty.' };
    const res = await runGit(['commit', '-m', message], root);
    return { ok: res.ok, error: res.ok ? null : (res.stderr || res.stdout) };
  });

  ipcMain.handle('git:branches', async (evt, projectRoot) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const res = await runGit(['branch', '--list', '--format=%(HEAD)|%(refname:short)'], root);
    if (!res.ok) return { ok: false, error: res.stderr };
    const branches = res.stdout.split('\n').filter(Boolean).map((line) => {
      const [head, name] = line.split('|');
      return { name, current: head === '*' };
    });
    return { ok: true, branches };
  });

  ipcMain.handle('git:checkout-branch', async (evt, projectRoot, branchName) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    if (!isSafeGitRef(branchName)) return { ok: false, error: 'Invalid branch name.' };
    const res = await runGit(['checkout', branchName, '--'], root);
    return { ok: res.ok, error: res.ok ? null : (res.stderr || res.stdout) };
  });

  ipcMain.handle('git:create-branch', async (evt, projectRoot, branchName) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    if (!isSafeGitRef(branchName)) return { ok: false, error: 'Invalid branch name.' };
    const res = await runGit(['checkout', '-b', branchName], root);
    return { ok: res.ok, error: res.ok ? null : (res.stderr || res.stdout) };
  });

  ipcMain.handle('git:log', async (evt, projectRoot, limit = 50) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const format = '%H%x1f%h%x1f%an%x1f%ar%x1f%s';
    const res = await runGit(['log', `-n${Math.max(1, Math.min(1000, parseInt(limit, 10) || 50))}`, `--pretty=format:${format}`], root);
    if (!res.ok) return { ok: false, error: res.stderr || 'No commits yet.' };
    const commits = res.stdout.split('\n').filter(Boolean).map((line) => {
      const [hash, short, author, date, subject] = line.split('\x1f');
      return { hash, short, author, date, subject };
    });
    return { ok: true, commits };
  });

  ipcMain.handle('git:ignored-paths', async (evt, projectRoot) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, paths: [] };
    // --directory collapses a wholly-ignored folder into one "name/" entry
    // instead of listing every file inside it — exactly what the tree filter
    // needs, and much cheaper than enumerating everything.
    const res = await runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], root);
    if (!res.ok) return { ok: false, paths: [] };
    return { ok: true, root, paths: res.stdout.split('\n').filter(Boolean) };
  });

  ipcMain.handle('git:show-commit', async (evt, projectRoot, hash) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    if (!/^[0-9a-fA-F]{4,64}$/.test(String(hash))) return { ok: false, error: 'Invalid commit hash.' };
    const res = await runGit(['show', hash, '--'], root);
    if (!res.ok) return { ok: false, error: res.stderr || 'Could not load commit.' };
    return { ok: true, diff: res.stdout };
  });

  ipcMain.handle('git:remote-status', async (evt, projectRoot) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
    if (!upstream.ok) return { ok: true, hasUpstream: false };
    const counts = await runGit(['rev-list', '--left-right', '--count', '@{u}...HEAD'], root);
    if (!counts.ok) return { ok: true, hasUpstream: true, remote: upstream.stdout.trim(), ahead: 0, behind: 0 };
    const [behind, ahead] = counts.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
    return { ok: true, hasUpstream: true, remote: upstream.stdout.trim(), ahead, behind };
  });

  ipcMain.handle('git:push', async (evt, projectRoot) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const authArgs = await githubAuthArgsForRemote(root);
    const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
    let res;
    if (!upstream.ok) {
      const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
      const branch = branchRes.stdout.trim();
      res = await runGit([...authArgs, 'push', '--set-upstream', 'origin', branch], root, { authSensitive: true, timeoutMs: 30000 });
    } else {
      res = await runGit([...authArgs, 'push'], root, { authSensitive: true, timeoutMs: 30000 });
    }
    return { ok: res.ok, error: res.ok ? null : (res.stderr || res.stdout || 'Push failed.') };
  });

  ipcMain.handle('git:pull', async (evt, projectRoot) => {
    const root = await getGitRoot(projectRoot);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const authArgs = await githubAuthArgsForRemote(root);
    // --no-rebase: always merge on divergent branches rather than letting git
    // fall back to asking for a pull.rebase preference it may not have set —
    // newer git refuses to guess and fails outright without this. Merge is the
    // safer default for a GUI client (no history rewriting to reason about
    // without a terminal open), and matches most other git GUIs' defaults.
    const res = await runGit([...authArgs, 'pull', '--no-rebase'], root, { authSensitive: true, timeoutMs: 30000 });
    return { ok: res.ok, error: res.ok ? null : (res.stderr || res.stdout || 'Pull failed.') };
  });
  return {};
}

module.exports = { register };
