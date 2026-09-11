import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const source = await readFile(new URL('../../plugins/vscode/index.js', import.meta.url), 'utf8')
const { createAdapter } = await import('data:text/javascript,' + encodeURIComponent(source))
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    process.stdout.on('data', data => { stdout += data })
    process.stderr.on('data', data => { stderr += data })
    process.on('error', reject)
    process.on('close', code => resolve({ code, stdout, stderr }))
    process.stdin.end(input)
  })
}

test('VS Code accepts a reported socket/token and surfaces failed starts and stops', async () => {
  const sdk = { exec: async () => ({ code: 0, stdout: 'SOCKET=/tmp/editor.sock\nTOKEN=example\n', stderr: '' }) }
  const adapter = createAdapter(sdk)
  assert.deepEqual(await adapter.start(), { socket: '/tmp/editor.sock', token: 'example' })
  sdk.exec = async () => ({ code: 1, stdout: 'SOCKET=/tmp/stale.sock', stderr: 'previous server did not stop' })
  await assert.rejects(adapter.start(), /previous server did not stop/)
  await assert.rejects(adapter.stop(), /previous server did not stop/)
})

test('generated startup and shutdown scripts remain valid POSIX shell', async () => {
  const adapter = createAdapter({ exec: async ([shell, option, script]) => {
    assert.equal(shell, 'sh'); assert.equal(option, '-c')
    const parsed = await run('sh', ['-n'], script)
    assert.equal(parsed.code, 0, parsed.stderr)
    return { code: 0, stdout: 'SOCKET=/tmp/editor.sock\nTOKEN=example', stderr: '' }
  } })
  await adapter.start(); await adapter.stop()
})

// Opt in on macOS with PLYDESK_TEST_HOST=user@linux. Uses only a unique /tmp
// fixture, a fake editor, and Python's socket library; no real editor is stopped.
const host = process.env.PLYDESK_TEST_HOST
const shell = script => host
  ? run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'sh', '-s'], script)
  : run('sh', ['-s'], script)
test('renamed servers restart, existing data survives, and current servers are reused', {
  skip: !host && process.platform !== 'linux', timeout: 30000,
}, async () => {
  const dir = `/tmp/plydesk-vscode-test-${randomUUID()}`
  // Replace the fixture's home references in the generated script without
  // changing HOME or touching the test runner's actual installation.
  const adapter = createAdapter({ exec: async ([, , script]) => shell(script.replaceAll('$HOME', dir)) })
  const check = async script => {
    const result = await shell(script)
    assert.equal(result.code, 0, result.stderr)
    return result.stdout.trim()
  }
  try {
    await check(`set -e
case_root=${quote(dir)}
server="$case_root/.sshdesk/opt/openvscode-server"
mkdir -p "$server/bin" "$server/out" "$case_root/.sshdesk/opt/openvscode-data/data/User" "$case_root/.sshdesk/opt/openvscode-data/extensions"
printf 'saved-theme' > "$case_root/.sshdesk/opt/openvscode-data/data/User/settings.json"
printf 'installed' > "$case_root/.sshdesk/opt/openvscode-data/extensions/example"
cat > "$server/bin/openvscode-server" <<'SH'
#!/bin/sh
root=$(dirname "$(dirname "$0")")
python3 "$root/out/server-main.js" "$@"
SH
chmod +x "$server/bin/openvscode-server"
cat > "$server/out/server-main.js" <<'PY'
import json, os, socket, sys
args = sys.argv[1:]
path = args[args.index('--socket-path') + 1]
with open(os.path.join(os.path.dirname(path), 'last-args.json'), 'w') as f:
    json.dump(args, f)
s = socket.socket(socket.AF_UNIX)
s.bind(path)
s.listen()
while True:
    connection, _ = s.accept()
    connection.close()
PY
nohup "$server/bin/openvscode-server" --socket-path "$case_root/.sshdesk/opt/openvscode.sock" </dev/null > "$case_root/fixture.log" 2>&1 &
echo $! > "$case_root/.sshdesk/opt/openvscode.pid"
for i in $(seq 1 50); do [ -S "$case_root/.sshdesk/opt/openvscode.sock" ] && break; sleep 0.1; done
test -S "$case_root/.sshdesk/opt/openvscode.sock"
mv "$case_root/.sshdesk" "$case_root/.plydesk"
`)
    const old = await check(`cat ${quote(dir + '/.plydesk/opt/openvscode.pid')}`)
    const started = await adapter.start()
    assert.equal(started.socket, dir + '/.plydesk/opt/openvscode.sock')
    assert.match(started.token, /^[a-f0-9]{32}$/)
    const current = await check(`cat ${quote(dir + '/.plydesk/opt/openvscode.pid')}`)
    assert.notEqual(current, old)
    const args = JSON.parse(await check(`cat ${quote(dir + '/.plydesk/opt/last-args.json')}`))
    assert.equal(args[args.indexOf('--user-data-dir') + 1], dir + '/.plydesk/opt/openvscode-data/data')
    assert.equal(args[args.indexOf('--extensions-dir') + 1], dir + '/.plydesk/opt/openvscode-data/extensions')
    assert.equal(await check(`cat ${quote(dir + '/.plydesk/opt/openvscode-data/data/User/settings.json')}`), 'saved-theme')
    assert.equal(await check(`cat ${quote(dir + '/.plydesk/opt/openvscode-data/extensions/example')}`), 'installed')
    assert.deepEqual(await adapter.start(), started)
    assert.equal(await check(`cat ${quote(dir + '/.plydesk/opt/openvscode.pid')}`), current)
    await adapter.stop()
    await check(`test ! -e ${quote(started.socket)}`)
  } finally {
    await adapter.stop().catch(() => {})
    await shell(`rm -rf ${quote(dir)}`)
  }
})
