/**
 * sshdesk plugin: System
 *
 * Shows only what implies a next action — failed units, reclaimable disk, swap
 * in use, VRAM held. Deliberately no CPU sparklines or network graphs: they
 * look like a product and answer nothing you would act on.
 */
export { createAdapter } from './adapter.js'

export const manifest = {
  id: 'system',
  name: 'System',
  description: 'Review memory, storage, and machine health.',
  icon: 'desk:cpu',
  window: { w: 1000, h: 640 },
}

const gb = b => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB`
  : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e3).toFixed(0)} KB`

export function createApp({ React, useFw, useApi }) {
  const { useState, useEffect, useCallback, useRef, useId } = React

  function Card({ tone = 'ok', label, value, hint, onClick }) {
    const Tag = onClick ? 'button' : 'div'
    return (
      <Tag className={`sys-card sys-${tone}`} onClick={onClick}>
        <div className="sys-card-value">{value}</div>
        <div className="sys-card-label">{label}</div>
        {hint && <div className="sys-card-hint">{hint}</div>}
      </Tag>
    )
  }

  function Bar({ pct, tone }) {
    return (
      <div className="sys-bar">
        <div className={`sys-bar-fill sys-${tone}-fill`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    )
  }

  return function System({ setTitle }) {
    const fw = useFw()
    const api = useApi()
    const [d, setD] = useState(null)
    const [err, setErr] = useState('')
    const [note, setNote] = useState('')
    const [busy, setBusy] = useState(false)
    const [log, setLog] = useState(null)
    const [big, setBig] = useState(null)
    const logSheet = useRef(null)
    const logTitle = useId()
    useEffect(() => {
      if (log === null) return
      const previous = document.activeElement
      logSheet.current?.focus()
      return () => { if (previous?.isConnected) previous.focus() }
    }, [log])

    const load = useCallback(async () => {
      setBusy(true); setErr('')
      try { setD(await api.overview()) }
      catch (e) { setErr(String(e)) }
      finally { setBusy(false) }
    }, [])

    useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [load])
    useEffect(() => { setTitle && setTitle('System') }, [setTitle])

    const act = async (fn, ok) => {
      setErr(''); setNote(''); setBusy(true)
      try { const r = await fn(); setNote(ok || r || 'done'); await load() }
      catch (e) { setErr(String(e).replace(/^Error:\s*/, '')) }
      finally { setBusy(false) }
    }

    const prune = async what => {
      const labels = { build: 'build cache', images: 'unused images', all: 'everything unused' }
      const ok = await fw.ui.confirm({
        title: `Prune ${labels[what]}?`,
        message: 'This permanently deletes Docker data that is not in use by a running container.',
        okLabel: 'Prune', danger: true,
      })
      if (ok) act(() => api.prune(what))
    }

    if (!d) {
      return <div className="desk-app sys-root"><div className="app-empty-state" role="status"><h2>{err ? 'Unable to read this machine' : 'Reading system…'}</h2><p>{err || 'Checking memory, storage, and services.'}</p>{err && <button className="app-button" onClick={load}>Try again</button>}</div></div>
    }

    const fullest = d.filesystems.reduce((a, b) => (b.pct > (a?.pct ?? -1) ? b : a), null)
    const reclaimable = d.docker.reduce((s, x) => s + x.free, 0)
    const swapping = d.memory.swapUsed > 0
    const vram = d.gpus.reduce((s, g) => s + g.usedMb, 0)

    return (
      <div className="desk-app sys-root">
        <div className="app-toolbar">
          <button className="app-button" onClick={load} disabled={busy}>Refresh</button>
          <span className="sys-dim">{d.uptime}</span>
          {d.load && <span className="sys-dim">load {d.load}</span>}
          <span className="sys-spacer" />
          {note && <span className="sys-note">{note}</span>}
        </div>

        {err && <div className="app-notice is-error" role="alert">{err}</div>}

        <div className="sys-scroll">
          <div className="sys-heading"><h1>System overview</h1><p>Memory, storage, and services on this machine.</p></div>
          <div className="sys-cards">
            <Card
              tone={d.failed.length ? 'bad' : 'ok'}
              value={d.failed.length}
              label="Failed services"
              hint={d.failed.length ? 'Needs attention' : 'All healthy'}
            />
            <Card
              tone={fullest && fullest.pct >= 90 ? 'bad' : fullest && fullest.pct >= 80 ? 'warn' : 'ok'}
              value={fullest ? `${fullest.pct}%` : '—'}
              label={fullest ? `Disk used · ${fullest.mount}` : 'Disk usage'}
              hint={fullest ? `${gb(fullest.avail)} free` : ''}
            />
            <Card
              tone={reclaimable > 5e9 ? 'warn' : 'ok'}
              value={gb(reclaimable)}
              label="Docker reclaimable"
              hint={reclaimable ? 'Review cleanup' : 'Nothing to reclaim'}
              onClick={reclaimable ? () => prune('all') : undefined}
            />
            <Card
              tone={swapping ? 'warn' : 'ok'}
              value={gb(d.memory.available)}
              label="Memory available"
              hint={swapping ? `${gb(d.memory.swapUsed)} swap in use` : 'No swap in use'}
            />
            {d.gpus.length > 0 && (
              <Card
                tone={vram > 0 ? 'warn' : 'ok'}
                value={`${(vram / 1024).toFixed(1)} GB`}
                label={`VRAM in use · ${d.gpus.length} GPU${d.gpus.length > 1 ? 's' : ''}`}
                hint={d.gpus.map(g => `${g.temp}°C`).join(' · ')}
              />
            )}
          </div>

          <div className="sys-sections">
          {d.failed.length > 0 && (
            <section className="sys-section">
              <h3>Services needing attention</h3>
              {d.failed.map(u => (
                <div key={u.unit} className="sys-row">
                  <span className="sys-dot sys-bad-dot" />
                  <span className="mono">{u.unit}</span>
                  <span className="sys-dim sys-grow">{u.description}</span>
                  <button className="app-button" disabled={busy}
                          onClick={() => api.unitLog(u.unit).then(setLog).catch(e => setErr(String(e)))}>
                    View log
                  </button>
                  <button className="app-button" disabled={busy}
                          onClick={() => act(() => api.restartUnit(u.unit), `restarted ${u.unit}`)}>
                    Restart
                  </button>
                </div>
              ))}
            </section>
          )}

          <section className="sys-section">
            <h3>Filesystems</h3>
            {d.filesystems.map(fs => (
              <div key={fs.mount} className="sys-fs">
                <div className="sys-fs-head">
                  <span className="mono">{fs.mount}</span>
                  <span className="sys-dim">{gb(fs.avail)} free of {gb(fs.size)}</span>
                  <span className={fs.pct >= 90 ? 'sys-bad-text' : fs.pct >= 80 ? 'sys-warn-text' : 'sys-dim'}>
                    {fs.pct}%
                  </span>
                </div>
                <Bar pct={fs.pct} tone={fs.pct >= 90 ? 'bad' : fs.pct >= 80 ? 'warn' : 'ok'} />
              </div>
            ))}
            <div className="sys-actions">
              <button className="app-button" disabled={busy}
                      onClick={() => act(async () => { setBig(await api.bigDirs('/')); return 'scanned /' })}>
                Inspect disk usage
              </button>
            </div>
            {big && (
              <div className="sys-dirs">
                {big.map(x => (
                  <div key={x.path} className="sys-row">
                    <span className="mono sys-size">{x.size}</span>
                    <span className="mono sys-dim">{x.path}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {d.docker.length > 0 && (
            <section className="sys-section">
              <h3>Docker</h3>
              {d.docker.map(x => (
                <div key={x.type} className="sys-row">
                  <span className="sys-grow">{x.type}</span>
                  <span className="sys-dim mono">{x.size}</span>
                  <span className={x.free > 1e9 ? 'sys-warn-text mono' : 'sys-dim mono'}>
                    {x.reclaimable} reclaimable
                  </span>
                </div>
              ))}
              <div className="sys-actions">
                <button className="app-button" disabled={busy} onClick={() => prune('build')}>Clean build cache…</button>
                <button className="app-button" disabled={busy} onClick={() => prune('images')}>Clean images…</button>
                <button className="app-button is-danger" disabled={busy} onClick={() => prune('all')}>Clean unused data…</button>
              </div>
            </section>
          )}

          {d.gpus.length > 0 && (
            <section className="sys-section">
              <h3>GPU</h3>
              {d.gpus.map(g => (
                <div key={g.index} className="sys-fs">
                  <div className="sys-fs-head">
                    <span className="mono">{g.name}</span>
                    <span className="sys-dim">{(g.usedMb / 1024).toFixed(1)} / {(g.totalMb / 1024).toFixed(0)} GB</span>
                    <span className="sys-dim">{g.util}% · {g.temp}°C</span>
                  </div>
                  <Bar pct={g.totalMb ? (g.usedMb / g.totalMb) * 100 : 0}
                       tone={g.usedMb / g.totalMb > 0.9 ? 'bad' : 'ok'} />
                </div>
              ))}
              {d.gpuProcs.length > 0 && (
                <div className="sys-dirs">
                  {d.gpuProcs.map(p => (
                    <div key={p.pid} className="sys-row">
                      <span className="mono sys-size">{(p.usedMb / 1024).toFixed(1)} GB</span>
                      <span className="mono">{p.name}</span>
                      <span className="sys-dim mono">pid {p.pid}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
          </div>
        </div>
        <footer className="app-statusbar"><span>{busy ? 'Refreshing…' : 'Refreshes every 15 seconds'}</span><span className="app-status-end">{fw.host.current().split('@').pop()}</span></footer>

        {log !== null && (
          <div className="sys-modal" onClick={() => setLog(null)}>
            <div className="sys-log-sheet" ref={logSheet} role="dialog" aria-labelledby={logTitle} tabIndex={-1}
              onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setLog(null) } }} onClick={e => e.stopPropagation()}>
              <header><strong id={logTitle}>Service log</strong><button className="app-button" onClick={() => setLog(null)}>Close</button></header>
              <pre className="sys-log" tabIndex={0}>{log || 'No log entries available.'}</pre>
            </div>
          </div>
        )}
      </div>
    )
  }
}
