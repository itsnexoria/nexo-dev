// Remote terminals: SSH hosts, Docker containers and dev containers, opened as normal PTY tabs.
// The main process validates every field and runs the client binary without a shell.
(function () {
  function open(remote: any) {
    toggleTerminal(true);
    const t = (window as any).createTerminalSession(remote);
    switchTerminalTab(t.id);
  }

  async function ssh() {
    const res = await window.nexo.remoteSshHosts();
    const hosts: string[] = (res && res.hosts) || [];
    showModal({
      title: 'SSH Terminal',
      confirmLabel: 'Connect',
      fields: [
        { id: 'host', label: hosts.length ? `Host — from ~/.ssh/config: ${hosts.slice(0, 6).join(', ')}${hosts.length > 6 ? '…' : ''}` : 'Host (host, user@host or alias)', initial: hosts[0] || '' },
        { id: 'port', label: 'Port (optional)', placeholder: '22' },
      ],
      onConfirm: ({ host, port }: any): any => {
        if (!host.trim()) return 'Enter a host.';
        open({ kind: 'ssh', target: host.trim(), port: port.trim() || undefined, label: 'ssh ' + host.trim() });
        return null;
      },
    });
  }

  async function docker() {
    const res = await window.nexo.remoteDockerList();
    if (!res.ok) { flashToast(res.error || 'Docker is not available'); return; }
    if (!res.names.length) { flashToast('No running containers'); return; }
    showModal({
      title: 'Docker Container Terminal',
      confirmLabel: 'Attach',
      fields: [
        { id: 'container', label: `Running: ${res.names.slice(0, 8).join(', ')}${res.names.length > 8 ? '…' : ''}`, initial: res.names[0] },
        { id: 'shell', label: 'Shell', initial: '/bin/sh' },
      ],
      onConfirm: ({ container, shell }: any): any => {
        if (!container.trim()) return 'Enter a container name.';
        open({ kind: 'docker', container: container.trim(), shell: shell.trim() || undefined, label: 'docker ' + container.trim() });
        return null;
      },
    });
  }

  function devcontainer() {
    if (!state.projectRoot) { flashToast('Open a folder first'); return; }
    open({ kind: 'devcontainer', folder: state.projectRoot, label: 'dev container' });
  }

  PALETTE_COMMANDS.push(
    { label: 'Remote: SSH Terminal…', run: ssh },
    { label: 'Remote: Docker Container Terminal…', run: docker },
    { label: 'Remote: Dev Container Terminal (devcontainer CLI)', run: devcontainer },
  );
  (window as any).nexoRemote = { open };
})();
