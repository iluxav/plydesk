/**
 * sshdesk plugin: VS Code
 *
 * A test of whether the platform is real: this adds a full IDE with no change
 * to sshdesk itself. The dependency comes from the manifest, the server is
 * started with `sdk.exec`, the socket is forwarded with `fw.net.forwardSocket`
 * on the live connection, and the result is a window.
 *
 * The editor is a first-party child webview inside its sshdesk desktop
 * window. It keeps browser storage and authentication cookies without opening
 * a separate macOS window. The desktop owns its bounds and lifetime.
 *
 * Why a server on the remote rather than VS Code Web bundled in the app: web
 * builds only run *web* extensions. No rust-analyzer, no gopls, no debugger —
 * anything that spawns a process needs an extension host on a machine. Putting
 * that host where the code already is, is the whole point.
 */

const VERSION = '1.109.5'
const REL = `https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${VERSION}`

export const manifest = {
  id: 'vscode',
  name: 'VS Code',
  description: 'Work on remote projects in a full code editor.',
  icon: 'lucide:code-xml',
  window: { w: 1180, h: 780 },

  requires: [{
    kind: 'archive',
    command: 'openvscode-server',
    url: `${REL}/openvscode-server-v${VERSION}-linux-\${arch}.tar.gz`,
    // Published by GitHub alongside the assets. Checked before anything is
    // unpacked — this downloads a binary that then gets executed.
    sha256: {
      aarch64: '36d9c14036489b63de84ebace837fcacf7e60e669a0dc715802c5443684ea4dc',
      x86_64:  'b433bf4f0227321a7014d8460d10a8f958adc0f45aa79bd889e84e65e8f88363',
      armv7l:  'f84ac0dcea0bdeac07e172e58903b38bc5ef0ac94b0bf2ab2ce4eca325ab98bb',
    },
    // uname -m says aarch64; the release calls it arm64.
    arch_map: { aarch64: 'arm64', x86_64: 'x64', armv7l: 'armhf' },
    into: 'openvscode-server',
    bin: 'bin/openvscode-server',
  }],

}

const OPT = '$HOME/.sshdesk/opt'
const LOG = `${OPT}/openvscode.log`
const PID = `${OPT}/openvscode.pid`
const SOCK = `${OPT}/openvscode.sock`
// The token is generated here, not parsed back out of the log: bound to a
// socket the server prints no URL, so there is no "tkn=" line to read. Kept
// beside the pid so an already-running server can be adopted with its token.
const TOKF = `${OPT}/openvscode.token`
/** The literal path, for the forward — the shell expands $HOME, we cannot. */
const SOCK_MARK = 'SOCKET='

export function createAdapter(sdk) {
  // A unix socket rather than a TCP port, and no connection token.
  //
  // That combination sounds worse and is better. The token is delivered as a
  // SameSite=Lax cookie via a redirect, which a cross-origin iframe never gets
  // to keep — the app is tauri://localhost and the server is 127.0.0.1, so the
  // cookie is third-party and WKWebView drops it. The frame just 403s.
  //
  // Binding a socket removes the reason the token existed. There is no TCP
  // port on the remote for anyone to reach, and umask 077 means no other user
  // can open the socket either. What reaches the Mac is one loopback port,
  // which is exactly what every other forward here already is.
  const START = `
    set -e
    umask 077
    D="${OPT}/openvscode-server"
    if [ -f "${PID}" ] && kill -0 "$(cat "${PID}" 2>/dev/null)" 2>/dev/null && [ -S "${SOCK}" ]; then
      # Adopting an existing server inherits whatever permissions it was
      # started with, which may predate this. Re-assert them.
      chmod 700 "${SOCK}" 2>/dev/null || true
      echo "${SOCK_MARK}${SOCK}"
      echo "TOKEN=$(cat "${TOKF}" 2>/dev/null)"
      exit 0
    fi
    rm -f "${LOG}" "${SOCK}"
    TOK=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
    printf '%s' "$TOK" > "${TOKF}"
    chmod 600 "${TOKF}"
    nohup "$D/bin/openvscode-server" \
      --socket-path "${SOCK}" --connection-token "$TOK" \
      --server-data-dir "${OPT}/openvscode-data" \
      --user-data-dir "${OPT}/openvscode-user" \
      --extensions-dir "${OPT}/openvscode-extensions" \
      --telemetry-level off --accept-server-license-terms \
      > "${LOG}" 2>&1 &
    echo $! > "${PID}"
    for _ in $(seq 1 80); do
      [ -S "${SOCK}" ] && break
      sleep 0.25
    done
    [ -S "${SOCK}" ] || { echo "the server did not create its socket" >&2; exit 1; }
    # Explicit, not left to umask: this is what replaces the connection token,
    # so it should not depend on how the process happened to be started.
    chmod 700 "${SOCK}"
    echo "${SOCK_MARK}${SOCK}"
    echo "TOKEN=$TOK"
  `

  const STOP = `
    if [ -f "${PID}" ]; then kill "$(cat "${PID}")" 2>/dev/null || true; rm -f "${PID}"; fi
    rm -f "${SOCK}" "${TOKF}"
  `

  return {
    /** Start (or adopt) the server; returns the socket path it listens on. */
    async start() {
      const r = await sdk.exec(['sh', '-c', START])
      const line = (r.stdout || '').split('\n').map(s => s.trim())
        .find(s => s.startsWith(SOCK_MARK))
      if (!line) {
        const why = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n')
        throw new Error(why || 'the server did not report a socket')
      }
      const tkn = (r.stdout || '').split('\n').map(s => s.trim())
        .find(s => s.startsWith('TOKEN='))
      return { socket: line.slice(SOCK_MARK.length), token: tkn ? tkn.slice(6) : '' }
    },

    async stop() {
      await sdk.exec(['sh', '-c', STOP])
    },

    /** Last few log lines, for when starting goes wrong. */
    async log() {
      const r = await sdk.exec(['sh', '-c', `tail -30 "${LOG}" 2>/dev/null || true`])
      return r.stdout
    },
  }
}

export function createApp({ React, html, useApi, useFw, EmbeddedWebview }) {
  const { useState, useEffect, useCallback, useRef } = React

  return function VSCode({ setTitle, host }) {
    const api = useApi()
    const fw = useFw()
    const [err, setErr] = useState('')
    const [log, setLog] = useState('')
    const [status, setStatus] = useState('Starting VS Code…')
    const [url, setUrl] = useState('')
    const [ready, setReady] = useState(false)
    const socket = useRef('')

    useEffect(() => { setTitle && setTitle('VS Code') }, [setTitle])

    const machine = (host || fw.host.current() || '').replace(/^.*@/, '')

    const launch = useCallback(async () => {
      setErr(''); setLog(''); setUrl(''); setReady(false)
      setStatus('Starting VS Code…')
      try {
        const { socket: path, token } = await api.start()
        socket.current = path
        setStatus('Connecting your workspace…')
        // Added to the connection already open — no reconnect, no second
        // authentication. The port is derived from the forward, so the window
        // returns to the same web origin and keeps what it saved last time.
        const local = await fw.net.forwardSocket(path)
        const url = `http://127.0.0.1:${local}/${token ? `?tkn=${token}` : ''}`
        setUrl(url)
        setStatus('Opening the editor…')
      } catch (e) {
        setErr(String(e))
        setStatus('')
        try { setLog(await api.log()) } catch { /* best effort */ }
      }
    }, [api, fw, host, machine])

    useEffect(() => { launch() }, [launch])

    const stop = async () => {
      if (!await fw.ui.confirm({ title: 'Stop VS Code?', message: `This ends the editor server on ${machine}. Save your work in VS Code first.`, okLabel: 'Stop server' })) return
      try { await api.stop() } catch { /* may already be gone */ }
      if (socket.current) {
        try { await fw.net.unforwardSocket(socket.current) } catch { /* ditto */ }
      }
      setUrl('')
      setReady(false)
      setStatus('server stopped')
    }

    const stopped = status === 'server stopped'
    const loaded = () => { setReady(true); setStatus('') }
    const failed = message => { setErr(message); setUrl(''); setStatus('') }
    return html`
      <div class="desk-app vsc-root">
        ${url ? html`
          <${EmbeddedWebview} url=${url} title="VS Code" onReady=${loaded} onError=${failed} />
        ` : html`
          <div class="vsc-workspace">
            <span class="vsc-app-mark app-tile app-tile-vscode" aria-hidden="true">${'</>'}</span>
            <h1>${err ? 'Couldn’t open VS Code' : stopped ? 'VS Code is stopped' : 'Opening VS Code'}</h1>
            <p class="vsc-machine">${machine}</p>
            ${status && !stopped && html`<div class="vsc-progress" role="status"><span class="ui-spinner"></span>${status}</div>`}
            ${stopped && html`<div class="vsc-panel"><p class="vsc-note">Start it again when you’re ready to continue working.</p><button class="app-button is-primary" onClick=${launch}>Open VS Code</button></div>`}
            ${err && html`<div class="vsc-err" role="alert"><p>${err}</p>
              ${log && html`<details class="vsc-details"><summary>Connection details</summary><pre class="vsc-log">${log}</pre></details>`}
              <button class="app-button" onClick=${launch}>Try again</button></div>`}
          </div>
        `}
        <footer class="app-statusbar">
          <span>${ready ? 'Connected' : err ? 'Connection failed' : stopped ? 'Stopped' : status}</span>
          <span class="app-status-optional">${machine}</span>
          ${url && html`<button class="app-button vsc-stop" onClick=${stop}>Stop server…</button>`}
        </footer>
      </div>`
  }
}
