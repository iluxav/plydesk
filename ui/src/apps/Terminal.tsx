import { useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useFw } from '../wm/host'
import { onTokensChanged, resolve } from '../fw/tokens'
import { useWM } from '../wm/store'
import { closesOnExit, type Shortcut } from '../shortcuts/model'

let seq = 0

/** base64 -> bytes -> string, since PTY chunks can split a UTF-8 sequence. */
function decode(decoder: TextDecoder, b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  // stream: true keeps a partial multi-byte char for the next chunk
  return decoder.decode(bytes, { stream: true })
}

export function Terminal({ setTitle, shortcut, winId }: { setTitle?: (t: string) => void; shortcut?: Extract<Shortcut, { kind: 'tui' }>; winId?: string }) {
  const fw = useFw()
  const host = useRef<HTMLDivElement>(null)
  const { dispatch } = useWM()
  const [attempt, setAttempt] = useState(0)
  const [finished, setFinished] = useState(false)
  const [status, setStatus] = useState('Opening session…')
  const [dimensions, setDimensions] = useState('')

  useEffect(() => {
    if (!host.current) return
    const id = `term-${++seq}`
    const decoder = new TextDecoder('utf-8', { fatal: false })
    setStatus('Opening session…'); setFinished(false)
    const closeWindow = () => { if (winId) dispatch({ t: 'close', id: winId }) }
    const target = fw.host.current()

    const term = new Xterm({
      fontSize: 13,
      lineHeight: 1.3,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: '#1a1d24', foreground: '#e6e8ec', cursor: '#60a5fa',
        selectionBackground: '#60a5fa55',
        black: '#1a1d24', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
        blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e6e8ec',
        brightBlack: '#5a6272', brightRed: '#fca5a5', brightGreen: '#86efac',
        brightYellow: '#fcd34d', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9', brightWhite: '#ffffff',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host.current)
    fit.fit()
    const updateTheme = () => {
      term.options.theme = { ...term.options.theme,
        background: resolve('desk.panel', target).value,
        foreground: resolve('desk.fg', target).value,
        cursor: resolve('desk.accent', target).value,
        selectionBackground: resolve('desk.selection', target).value,
      }
    }
    updateTheme()
    const offTheme = onTokensChanged(updateTheme)

    setTitle?.(shortcut?.name || `Terminal — ${target}`)

    let disposed = false, exited = false, opened = false
    let closeOnCtrlC = shortcut?.closeOnCtrlC
    const unlistens: Array<() => void> = []

    void (async () => {
      try {
        // withGlobalTauri is enabled, so use the global API rather than a
        // dynamic import of @tauri-apps/api — one less thing to bundle and
        // one less place for module resolution to fail silently.
        const listen = (window as any).__TAURI__?.event?.listen
        if (typeof listen !== 'function') {
          throw new Error('Tauri event API unavailable')
        }

        const un1 = await listen('term:data', (e: any) => {
          if (!disposed && e.payload.id === id) term.write(decode(decoder, e.payload.b64))
        })
        unlistens.push(un1)
        const un2 = await listen('term:exit', (e: any) => {
          if (disposed || e.payload.id !== id) return
          exited = true
          if (shortcut && closesOnExit(e.payload.code)) { closeWindow(); return }
          const message = shortcut ? `Command exited${e.payload.code == null ? '' : ` with code ${e.payload.code}`}` : 'Session closed'
          term.write(`\r\n\x1b[2m[${message.toLowerCase()}]\x1b[0m\r\n`)
          setStatus(message); setFinished(true)
        })
        unlistens.push(un2)
        if (disposed) { un1(); un2(); return }

        // Before layout settles xterm reports 0 — never ask for a 0x0 pty.
        const cols = term.cols > 0 ? term.cols : 80
        const rows = term.rows > 0 ? term.rows : 24
        const launch = await fw.term.open(id, target, cols, rows, shortcut?.id)
        if (disposed) { await fw.term.close(id); return }
        opened = true
        if (launch) { closeOnCtrlC = launch.closeOnCtrlC; setTitle?.(launch.name) }
        if (!exited) { setStatus(launch?.command || 'SSH session'); setDimensions(`${cols} × ${rows}`) }

        term.onData(d => {
          if (exited) return
          const write = fw.term.write(id, d).catch(() => {})
          if (closeOnCtrlC && d.includes('\x03')) void write.finally(closeWindow)
        })
        term.focus()
      } catch (err) {
        if (!disposed) {
          setStatus('Couldn’t start session'); setFinished(true)
          term.write(`\r\n\x1b[31m${String(err)}\x1b[0m\r\n`)
        }
      }
    })()

    // xterm needs an explicit fit; the window has no resize event of its own.
    const ro = new ResizeObserver(() => {
      if (!host.current?.clientWidth || !host.current?.clientHeight) return
      try {
        fit.fit()
        setDimensions(`${term.cols} × ${term.rows}`)
        if (opened && !exited) void fw.term.resize(id, term.cols, term.rows).catch(() => {})
      } catch { /* element detached */ }
    })
    ro.observe(host.current)

    return () => {
      disposed = true
      ro.disconnect()
      offTheme()
      unlistens.forEach(u => u())
      void fw.term.close(id).catch(() => {})
      term.dispose()
    }
  }, [fw, setTitle, shortcut, winId, dispatch, attempt])

  return <div className="desk-app"><div ref={host} className="terminal-surface" />
    <footer className="app-statusbar"><span className="terminal-status" title={status}>{status}</span>{shortcut && finished && <button className="shortcut-status-button" onClick={() => setAttempt(n => n + 1)}>Run again</button>}<span className="app-status-optional">{fw.host.current()}</span><span className="app-status-end">{dimensions}</span></footer>
  </div>
}
