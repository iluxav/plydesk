import { useCallback, useEffect, useRef, useState } from 'react'
import { useWM, nextId, type Win } from '../wm/store'
import { Window } from '../wm/Window'
import { HostScope } from '../wm/host'
import { Requires } from '../wm/Requires'
import { DesktopFiles } from './DesktopFiles'
import { AppBoundary } from '../wm/AppBoundary'
import { declareCoreTokens } from './tokens'
import { onTokensChanged, setConfig, value as tokenValue } from '../fw/tokens'
import { loadIconPacks } from '../fw/icons'
import { applyTheme } from '../fw/theme'
import { APPS } from './registry'
import { Dock } from './Dock'
import { MenuBar } from './MenuBar'
import { Connections } from './Connections'
import { fw } from '../fw'
import { useDialog } from '../wm/Dialog'
import { setPasswordPrompt, resetSdk } from '../ext/sdk'
import { reloadPlugins, onPluginsChanged, reportPluginError } from '../ext/loader'
import { RuntimeBridge } from '../ext/RuntimeBridge'
import { KeyboardProvider } from '../keyboard/KeyboardProvider'
import { Launcher } from './Launcher'

export function Desktop() {
  const { state, dispatch } = useWM()
  /** Every connected machine. Windows are pinned to one of these. */
  const [hosts, setHosts] = useState<string[]>([])
  // Re-rendering on theme change keeps icon tokens live without every consumer
  // subscribing individually.
  const [themeRev, bumpTheme] = useState(0)
  /** Desktop pictures, one per machine, resolved from local paths. */
  const [wallpapers, setWallpapers] = useState<Record<string, string>>({})
  // The theme listener fires outside render, so it reads the host list from a
  // ref rather than closing over a stale copy.
  const hostsRef = useRef<string[]>([])
  /**
   * The focused pane. Each connected machine gets its own column, so where a
   * window *is* on screen tells you which machine it acts on — no mode to
   * remember, and no way to confuse two identical-looking Files windows.
   */
  const [active, setActive] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [launcher, setLauncher] = useState(false)
  const openLauncher = useCallback(() => setLauncher(true), [])
  const closeLauncher = useCallback(() => setLauncher(false), [])
  const dlg = useDialog()
  const [, bumpPlugins] = useState(0)

  const winsRef = useRef(state.wins)
  useEffect(() => { winsRef.current = state.wins })
  useEffect(() => { hostsRef.current = hosts }, [hosts])
  const activeRef = useRef<string | null>(null)
  useEffect(() => { activeRef.current = active }, [active])

  // Tokens, icon packs and config, once at boot.
  useEffect(() => {
    declareCoreTokens()
    let live = true
    ;(async () => {
      await loadIconPacks().catch(() => [])
      // Config used to have a shared section. Move whatever is left of it onto
      // the machines that were using it, once, rather than resetting colours
      // that somebody chose.
      await fw.config.migrate(fw.conns.list().map(c => `${c.user}@${c.host}`))
        .then(n => { if (n) console.info(`config: moved ${n} shared value(s) onto each machine`) })
        .catch(() => { /* nothing to move */ })
      const cfg = await fw.config.load().catch(() => null)
      if (!live) return
      if (cfg) {
        setConfig(cfg.values, cfg.machines)
        for (const w of cfg.warnings) console.warn('config:', w)
      }
      applyTheme(hostsRef.current, activeRef.current ?? '')
      bumpTheme(n => n + 1)
    })()
    return () => { live = false }
  }, [])

  useEffect(() => onTokensChanged(() => {
    applyTheme(hostsRef.current, activeRef.current ?? '')
    bumpTheme(n => n + 1)
  }), [])

  // The chrome takes its colours from the focused machine, so switching panes
  // has to repaint it.
  useEffect(() => { applyTheme(hosts, active ?? '') }, [active, hosts, themeRev])

  // One per machine, since a machine can override the picture. Re-read
  // whenever the theme changes; a path that no longer resolves leaves the
  // plain background rather than a broken image.
  useEffect(() => {
    let live = true
    const wanted = new Map<string, string>()
    for (const h of hosts) {
      const p = tokenValue('desk.wallpaper', h)
      if (p) wanted.set(h, p)
    }
    if (!wanted.size) { setWallpapers({}); return }
    Promise.all([...wanted].map(([h, p]) =>
      fw.wallpaper(p).then(url => [h, url] as const).catch(() => [h, ''] as const)))
      .then(pairs => { if (live) setWallpapers(Object.fromEntries(pairs)) })
    return () => { live = false }
  }, [themeRev, hosts])

  useEffect(() => { fw.ui._installDialogs(dlg) }, [dlg])
  useEffect(() => onPluginsChanged(removed => {
    winsRef.current.filter(w => removed.includes(w.appId)).forEach(w => dispatch({ t: 'close', id: w.id }))
    bumpPlugins(n => n + 1)
  }), [dispatch])

  useEffect(() => {
    setPasswordPrompt(async host =>
      dlg.prompt({
        title: 'Administrator password',
        label: `Needed to run a privileged command on ${host}`,
        placeholder: 'password',
        password: true,
        okLabel: 'Run',
      }))
  }, [dlg])

  // Apps opening other apps inherit the calling window's host when possible.
  useEffect(() => {
    fw.ui._install((appId, props) => {
      const app = APPS.find(a => a.id === appId)
      if (!app) return
      const host = (props?.host as string) ?? activeRef.current
      if (!host) return
      const existing = winsRef.current.find(w =>
        w.appId === appId && w.host === host && props?.path && (w.props as any)?.path === props.path)
      if (existing) { dispatch({ t: 'focus', id: existing.id }); return }
      const n = winsRef.current.filter(w => w.host === host).length
      const paneW = Math.floor(window.innerWidth / Math.max(1, hostsRef.current.length))
      const paneH = window.innerHeight - 38
      const w = Math.min(app.w, Math.max(280, paneW - 48))
      const h = Math.min(app.h, Math.max(200, paneH - 110))
      dispatch({ t: 'open', win: {
        id: nextId(appId), appId, host, title: app.title, icon: app.icon,
        x: Math.max(0, Math.min(40 + (n % 6) * 28, paneW - w)),
        y: Math.max(0, Math.min(32 + (n % 6) * 26, paneH - h)), w, h, props,
      }})
    })
  }, [dispatch])

  const reload = useCallback(async () =>
    reloadPlugins(appIds => {
      winsRef.current
        .filter(w => appIds.includes(w.appId))
        .forEach(w => dispatch({ t: 'close', id: w.id }))
    }), [dispatch])

  const connected = useCallback((target: string) => {
    setHosts(h => (h.includes(target) ? h : [...h, target]))
    setActive(target)
    setAdding(false)
    // The launcher's file index: walked now, while the desktop is still empty.
    void fw.for(target).search.build().catch(() => {})
  }, [])

  // Keep the index roughly current: shortly after Files changes something,
  // and on a slow clock for changes made elsewhere.
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const rebuild = (host: string) => {
      clearTimeout(timers.get(host))
      timers.set(host, setTimeout(() => { void fw.for(host).search.build().catch(() => {}) }, 3000))
    }
    const stop = fw.bus.on('fs:changed', (p: { host?: string } | undefined) => {
      const host = p?.host ?? activeRef.current
      if (host) rebuild(host)
    })
    const interval = setInterval(() => hostsRef.current.forEach(rebuild), 10 * 60 * 1000)
    return () => { stop(); clearInterval(interval); timers.forEach(t => clearTimeout(t)) }
  }, [])

  /** Disconnect one machine: its windows go with it, the others stay. */
  const disconnect = useCallback(async (target: string) => {
    winsRef.current.filter(w => w.host === target)
      .forEach(w => dispatch({ t: 'close', id: w.id }))
    try { await fw.for(target).host.disconnect() } catch { /* already gone */ }
    resetSdk(target)
    setHosts(prev => {
      const next = prev.filter(h => h !== target)
      setActive(cur => (cur === target ? next[0] ?? null : cur))
      return next
    })
  }, [dispatch])

  if (!active) {
    return (
      <Connections
        connected={hosts}
        onConnected={connected}
        onCancel={hosts.length ? () => setAdding(false) : undefined}
      />
    )
  }

  return (
    <KeyboardProvider active={active} onSwitchHost={setActive} onLauncher={openLauncher} disabled={adding}><div className="desktop-shell"><RuntimeBridge />
      <div className="absolute inset-0" inert={adding}>
      <MenuBar
        hosts={hosts}
        active={active}
        onSwitch={setActive}
        onAdd={() => setAdding(true)}
        onDisconnect={disconnect}
        onReloadPlugins={reload}
        onSearch={openLauncher}
      />

      {/* One column per machine. Windows are absolutely positioned inside their
          own pane, so a window can never drift onto another machine's half. */}
      {/* The picture sits under everything, including the menu bar, which is
          translucent so it picks the image up. */}

      {/* Each machine owns its window coordinates beneath the shared menu bar. */}
      <div className="desktop-panes">
        {hosts.map(h => {
          const mine = state.wins.filter(w => w.host === h)
          const focused = h === active
          return (
            <div
              key={h}
              // data-host is what the generated theme hooks onto, so this
              // machine's overrides apply to its pane and not to its neighbour.
              data-host={h}
              onPointerDownCapture={() => setActive(h)}
              // The pane paints the background rather than the body, so a
              // machine can have its own — and the picture sits above it.
              style={{ background: 'var(--color-desk-bg)' }}
              className="desktop-pane"
            >
              {!wallpapers[h] && <div className="desktop-ambient" aria-hidden />}
              {wallpapers[h] && (
                <>
                  <div aria-hidden
                       className="absolute inset-0 bg-cover bg-center bg-no-repeat pointer-events-none"
                       style={{ backgroundImage: `url(${wallpapers[h]})` }} />
                  {/* Over the picture: raising its opacity dims a bright photo
                      until the desktop icons are legible again. */}
                  <div aria-hidden className="absolute inset-0 pointer-events-none"
                       style={{ background: 'var(--color-desk-tint)' }} />
                </>
              )}
              {hosts.length > 1 && <div className="desktop-pane-heading">
                <span className="status-dot" /><span>{h}</span>
              </div>}
              {!mine.some(w => !w.minimized) && <div className="desktop-idle">
                <span className="desktop-idle-label"><span className="status-dot" /> Connected over SSH</span>
                <h2>{fw.conns.list().find(c => `${c.user}@${c.host}` === h)?.name || h.split('@')[1]}</h2>
                <p>Open an app from the dock to get started.</p>
              </div>}

              <DesktopFiles host={h} active={focused} />

              {mine.map(w => <DesktopWindow key={w.id} win={w} />)}
            </div>
          )
        })}
      </div>

      <Dock host={active} />
      </div>
      <Launcher host={active} open={launcher && !adding} onClose={closeLauncher} />
      {adding && <div className="connection-overlay">
        <Connections connected={hosts} onConnected={connected} onCancel={() => setAdding(false)} />
      </div>}
    </div></KeyboardProvider>
  )
}

/** A stable title callback keeps app effects from restarting on shell updates. */
function DesktopWindow({ win }: { win: Win }) {
  const { dispatch } = useWM()
  const setTitle = useCallback((title: string) => dispatch({ t: 'title', id: win.id, title }), [dispatch, win.id])
  const app = APPS.find(a => a.id === win.appId)
  if (!app) return null
  const Component = app.component
  return <Window win={win}>
    <HostScope host={win.host}>
      <AppBoundary key={app.id} name={app.title}
        onError={app.plugin?.developer ? message => reportPluginError(app.plugin!.directory, message) : undefined}>
        {app.plugin ? <Component app={app} appProps={win.props ?? {}} winId={win.id} host={win.host} setTitle={setTitle} /> :
          <Requires requires={app.requires} name={app.title}>
            <Component {...(win.props ?? {})} winId={win.id} host={win.host} setTitle={setTitle} />
          </Requires>}
      </AppBoundary>
    </HostScope>
  </Window>
}
