import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { useFw } from '../../wm/host'
import { onTokensChanged, resolve } from '../../fw/tokens'
import type { Shortcut } from '../../shortcuts/model'
import type { Pane } from './model'
import { terminalKey } from './shortcuts'

export type PaneInfo = {
  cwd?: string; title?: string; status: 'opening' | 'running' | 'closed' | 'error'; message?: string
  cols?: number; rows?: number; unread?: boolean; resultIndex?: number; resultCount?: number
}
export type PaneController = {
  focus: () => void; directory: () => Promise<string | undefined>; clear: () => void; restart: () => void
  search: (query: string, backwards?: boolean, matchCase?: boolean) => boolean; clearSearch: () => void
}
type Props = {
  pane: Pane; visible: boolean; focused: boolean; fontSize: number
  shortcut?: Extract<Shortcut, { kind: 'tui' }>
  onInfo: (id: string, patch: Partial<PaneInfo>) => void
  onController: (id: string, controller?: PaneController) => void
  onFocus: (id: string) => void
  onExit?: (code: number | null) => void
}

export function TerminalPane(props: Props) {
  const fw = useFw(), surface = useRef<HTMLDivElement>(null)
  const live = useRef(props), xterm = useRef<Xterm | null>(null), fitRef = useRef<() => void>(() => {})
  const unread = useRef(false)
  const [attempt, retry] = useState(0)
  useLayoutEffect(() => { live.current = props })

  useEffect(() => {
    const node = surface.current
    if (!node) return
    const { pane, shortcut } = live.current
    const id = `terminal-${crypto.randomUUID()}`, decoder = new TextDecoder()
    let disposed = false, opened = false, exited = false, closeOnCtrlC = shortcut?.closeOnCtrlC
    unread.current = false
    let frame = 0, poll: ReturnType<typeof setTimeout> | undefined
    let directoryRequest: Promise<string | undefined> | undefined
    const unlisten: Array<() => void> = []
    const info = (patch: Partial<PaneInfo>) => { if (!disposed) live.current.onInfo(pane.id, patch) }
    info({ status: 'opening', message: undefined, unread: false, cwd: pane.cwd })
    const term = new Xterm({ fontSize: live.current.fontSize, lineHeight: 1.3,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', cursorBlink: true,
      scrollback: 10000, screenReaderMode: true, allowProposedApi: true,
      theme: { black: '#1a1d24', red: '#f87171', green: '#4ade80', yellow: '#fbbf24', blue: '#60a5fa',
        magenta: '#c084fc', cyan: '#22d3ee', white: '#e6e8ec', brightBlack: '#5a6272', brightRed: '#fca5a5',
        brightGreen: '#86efac', brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff' } })
    xterm.current = term
    const fit = new FitAddon(), search = new SearchAddon()
    term.loadAddon(fit); term.loadAddon(search)
    term.loadAddon(new WebLinksAddon((_event, uri) => { void fw.net.openUrl(uri).catch(() => {}) }))
    term.open(node)
    const theme = () => { term.options.theme = { ...term.options.theme,
      background: resolve('desk.panel', fw.host.current()).value,
      foreground: resolve('desk.fg', fw.host.current()).value,
      cursor: resolve('desk.accent', fw.host.current()).value,
      selectionBackground: resolve('desk.selection', fw.host.current()).value } }
    theme(); unlisten.push(onTokensChanged(theme))
    term.attachCustomKeyEventHandler(event => !!shortcut || !terminalKey(event))
    const titleListener = term.onTitleChange(title => info({ title: title.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) }))
    unlisten.push(() => titleListener.dispose())
    const searchListener = search.onDidChangeResults(result => info(result))
    unlisten.push(() => searchListener.dispose())

    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (disposed || !node.clientWidth || !node.clientHeight) return
        try { fit.fit(); info({ cols: term.cols, rows: term.rows })
          if (opened && !exited) void fw.term.resize(id, term.cols, term.rows).catch(() => {})
        } catch { /* detached during window close */ }
      })
    }
    fitRef.current = resize; resize()
    const observer = new ResizeObserver(resize); observer.observe(node)

    const directory = (): Promise<string | undefined> => {
      if (!opened || exited || disposed) return Promise.resolve(undefined)
      if (directoryRequest) return directoryRequest
      directoryRequest = fw.term.directory(id).then(path => {
        if (!disposed && path) info({ cwd: path })
        return path || undefined
      }).catch(() => undefined).finally(() => { directoryRequest = undefined })
      return directoryRequest
    }
    const pollDirectory = async () => {
      if (disposed) return
      if (live.current.visible && document.visibilityState !== 'hidden' && node.clientWidth) await directory()
      if (!disposed && !exited) poll = setTimeout(pollDirectory, 1500)
    }
    live.current.onController(pane.id, {
      focus: () => term.focus(), directory, clear: () => term.clear(), restart: () => retry(n => n + 1),
      clearSearch: () => { search.clearDecorations(); term.clearSelection() },
      search: (query, backwards = false, matchCase = false) => {
        if (!query) { search.clearDecorations(); info({ resultCount: 0, resultIndex: -1 }); return false }
        const options = { caseSensitive: matchCase, decorations: { matchBackground: '#405161', matchOverviewRuler: '#88b9dc',
          activeMatchBackground: '#71613f', activeMatchColorOverviewRuler: '#fbbf24' } }
        return backwards ? search.findPrevious(query, options) : search.findNext(query, options)
      },
    })
    void (async () => {
      try {
        const listen = (window as any).__TAURI__?.event?.listen
        if (typeof listen !== 'function') throw new Error('Tauri event API unavailable')
        const dataOff = await listen('term:data', (event: any) => {
          if (disposed || event.payload.id !== id) return
          const bytes = Uint8Array.from(atob(event.payload.b64), c => c.charCodeAt(0))
          term.write(decoder.decode(bytes, { stream: true }))
          if (!live.current.visible && !unread.current) { unread.current = true; info({ unread: true }) }
          else if (live.current.visible) unread.current = false
        })
        if (disposed) { dataOff(); return }; unlisten.push(dataOff)
        const exitOff = await listen('term:exit', (event: any) => {
          if (disposed || event.payload.id !== id) return
          exited = true; clearTimeout(poll)
          const code = event.payload.code
          info({ status: 'closed', message: code ? `Exited with code ${code}` : 'Session ended' })
          term.write(`\r\n\x1b[2m[Session ended${code ? ` · exit ${code}` : ''}]\x1b[0m\r\n`)
          live.current.onExit?.(code ?? null)
        })
        if (disposed) { exitOff(); return }; unlisten.push(exitOff)
        const launch = await fw.term.open(id, fw.host.current(), Math.max(2, term.cols), Math.max(1, term.rows), shortcut?.id, pane.cwd)
        if (disposed) { await fw.term.close(id); return }
        opened = true
        if (launch) closeOnCtrlC = launch.closeOnCtrlC
        if (!exited) { info({ status: 'running', message: launch?.command }); void pollDirectory() }
        const input = term.onData(data => {
          if (exited || disposed) return
          const write = fw.term.write(id, data).catch(() => {})
          if (closeOnCtrlC && data.includes('\x03')) void write.finally(() => live.current.onExit?.(130))
        })
        unlisten.push(() => input.dispose())
        resize()
        if (live.current.focused && live.current.visible) term.focus()
      } catch (error) {
        if (!disposed) { exited = true; info({ status: 'error', message: String(error) })
          term.write(`\r\n\x1b[31m${String(error)}\x1b[0m\r\n`) }
      }
    })()
    return () => {
      disposed = true; clearTimeout(poll); cancelAnimationFrame(frame); observer.disconnect()
      unlisten.forEach(stop => stop()); live.current.onController(pane.id, undefined)
      void fw.term.close(id).catch(() => {}); term.dispose(); xterm.current = null
    }
  }, [fw, props.pane.id, attempt])

  useEffect(() => { if (xterm.current) { xterm.current.options.fontSize = props.fontSize; fitRef.current() } }, [props.fontSize])
  useEffect(() => {
    if (props.visible) { unread.current = false; props.onInfo(props.pane.id, { unread: false }); fitRef.current()
      if (props.focused) xterm.current?.focus() }
  }, [props.visible, props.focused, props.pane.id, props.onInfo])
  return <div className="terminal-viewport" ref={surface} onFocusCapture={() => props.onFocus(props.pane.id)} />
}
