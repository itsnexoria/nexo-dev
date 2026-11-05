'use strict';
// Remote terminals: builds the (file, args) pair for an SSH / Docker / dev-container PTY from a *descriptor*.
// The renderer never supplies a command line — only descriptor fields, each validated here and passed as an
// argv element (no shell), so a crafted host or container name cannot inject options or commands.
const HOST_RE = /^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,253}$|^(?:[A-Za-z0-9._-]{1,64}@)?\[[0-9A-Fa-f:.]{2,45}\]$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'ash', '/bin/sh', '/bin/bash', '/bin/zsh', '/bin/ash']);

function build(desc) {
  if (!desc || typeof desc !== 'object') throw new Error('Bad remote descriptor.');
  switch (desc.kind) {
    case 'ssh': {
      if (typeof desc.target !== 'string' || !HOST_RE.test(desc.target)) throw new Error('Invalid SSH host (use host, user@host or an alias from ~/.ssh/config).');
      const args = [];
      if (desc.port != null && desc.port !== '') {
        const port = Number(desc.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port.');
        args.push('-p', String(port));
      }
      args.push('--', desc.target.replace(/[[\]]/g, ''));
      return { file: 'ssh', args, label: 'ssh ' + desc.target };
    }
    case 'docker': {
      if (typeof desc.container !== 'string' || !NAME_RE.test(desc.container)) throw new Error('Invalid container name.');
      const shell = desc.shell == null || desc.shell === '' ? '/bin/sh' : desc.shell;
      if (!SHELLS.has(shell)) throw new Error('Unsupported shell.');
      return { file: 'docker', args: ['exec', '-it', desc.container, shell], label: 'docker ' + desc.container };
    }
    case 'devcontainer': {
      if (typeof desc.folder !== 'string' || !desc.folder) throw new Error('A workspace folder is required.');
      const shell = desc.shell == null || desc.shell === '' ? '/bin/bash' : desc.shell;
      if (!SHELLS.has(shell)) throw new Error('Unsupported shell.');
      return { file: 'devcontainer', args: ['exec', '--workspace-folder', desc.folder, shell], label: 'dev container' };
    }
    default: throw new Error('Unknown remote kind.');
  }
}

// Concrete (non-wildcard) `Host` aliases from an ssh_config text.
function parseSshHosts(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*Host\s+(.+?)\s*$/i.exec(line);
    if (!m) continue;
    for (const h of m[1].split(/\s+/)) if (h && !/[*?!]/.test(h) && HOST_RE.test(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

// `docker ps --format {{.Names}}` output -> names.
const parseDockerNames = (text) => String(text).split(/\r?\n/).map((s) => s.trim()).filter((n) => NAME_RE.test(n));

module.exports = { build, parseSshHosts, parseDockerNames, HOST_RE, NAME_RE };
