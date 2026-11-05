const test = require('node:test');
const assert = require('node:assert');
const { build, parseSshHosts, parseDockerNames } = require('../lib/remote');

test('ssh: builds argv, supports user@host, ports and ipv6', () => {
  assert.deepStrictEqual(build({ kind: 'ssh', target: 'me@box.example.com', port: 2222 }), { file: 'ssh', args: ['-p', '2222', '--', 'me@box.example.com'], label: 'ssh me@box.example.com' });
  assert.deepStrictEqual(build({ kind: 'ssh', target: 'myalias' }).args, ['--', 'myalias']);
  assert.ok(build({ kind: 'ssh', target: 'me@[::1]' }));
});
test('ssh: rejects option/command injection and bad ports', () => {
  for (const t of ['-oProxyCommand=evil', 'a b', 'host;rm -rf /', '$(id)', 'a@b@c', '', 'host\nx', '`x`']) assert.throws(() => build({ kind: 'ssh', target: t }), /Invalid SSH host/, t);
  assert.throws(() => build({ kind: 'ssh', target: 'h', port: 0 }), /port/);
  assert.throws(() => build({ kind: 'ssh', target: 'h', port: 70000 }), /port/);
  assert.throws(() => build({ kind: 'ssh', target: 'h', port: '22; ls' }), /port/);
});
test('docker: validates container and shell', () => {
  assert.deepStrictEqual(build({ kind: 'docker', container: 'my-app_1' }).args, ['exec', '-it', 'my-app_1', '/bin/sh']);
  assert.deepStrictEqual(build({ kind: 'docker', container: 'c', shell: 'bash' }).args, ['exec', '-it', 'c', 'bash']);
  assert.throws(() => build({ kind: 'docker', container: '--privileged' }), /container/);
  assert.throws(() => build({ kind: 'docker', container: 'c', shell: 'rm -rf /' }), /shell/);
});
test('devcontainer and unknown kinds', () => {
  assert.deepStrictEqual(build({ kind: 'devcontainer', folder: '/w/p' }).args, ['exec', '--workspace-folder', '/w/p', '/bin/bash']);
  assert.throws(() => build({ kind: 'devcontainer' }), /folder/);
  assert.throws(() => build({ kind: 'telnet' }), /Unknown/);
  assert.throws(() => build(null), /Bad/);
});
test('parseSshHosts skips wildcards; parseDockerNames filters junk', () => {
  assert.deepStrictEqual(parseSshHosts('Host *\n  User x\nHost dev prod-*\nHost  staging  -oBad\n host2'), ['dev', 'staging']);
  assert.deepStrictEqual(parseDockerNames('web\n\n--bad\napi_1\n'), ['web', 'api_1']);
});
