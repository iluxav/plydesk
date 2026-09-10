/**
 * plydesk plugin: systemctl
 *
 * Convention: ~/.plydesk/plugins/<name>/index.js exporting `manifest`,
 * `createAdapter` and `createApp`.
 *
 * Ported to tier 1: reads go over D-Bus (typed both ways, no parsing, nothing
 * spawned on the remote), writes stay on sudo, and only the log tail still
 * shells out. Everything above the adapter is ordinary JavaScript — the
 * platform passes React in, so a plugin never bundles its own copy.
 */

export const manifest = {
  id: 'systemctl',
  name: 'Services',
  description: 'Inspect and manage systemd services.',
  icon: 'desk:service',
  window: { w: 940, h: 580 },
}

export function createAdapter(sdk) {
  const SYSTEMD = 'org.freedesktop.systemd1'
  const MANAGER = '/org/freedesktop/systemd1'

  const UNIT = /^[A-Za-z0-9@._:-]+$/
  const checkUnit = u => {
    if (!UNIT.test(u)) throw new Error(`refusing suspicious unit name: ${u}`)
    return u
  }

  const ACTIONS = ['start', 'stop', 'restart', 'reload', 'enable', 'disable']

  /** ListUnits returns a tuple per unit; these are its field positions. */
  const NAME = 0, DESC = 1, LOAD = 2, ACTIVE = 3, SUB = 4, OBJ = 6

  return {
    /**
     * Tier 1. This replaces a capability probe (does systemd support -o json?),
     * a JSON path, and a whole column-splitting fallback parser for older
     * systemd — because the bus API has been the same shape the entire time.
     * It also spawns no process on the remote, which is where the latency was.
     */
    async list() {
      const [units] = await sdk.dbus.systemd('ListUnits')
      return units
        .filter(u => u[NAME].endsWith('.service'))
        .map(u => ({
          unit: u[NAME],
          description: u[DESC],
          load: u[LOAD],
          active: u[ACTIVE],
          sub: u[SUB],
          path: u[OBJ],
        }))
    },

    /** Typed property, so there is no exit code to reinterpret. */
    async isActive(unit) {
      const [path] = await sdk.dbus.systemd('GetUnit', 's', [checkUnit(unit)])
      return await sdk.dbus.get(SYSTEMD, path, `${SYSTEMD}.Unit`, 'ActiveState')
    },

    /**
     * Deliberately mixed tiers: the facts come from typed properties, the log
     * tail from journalctl. There is no bus API that renders a log, and
     * pretending otherwise would mean parsing something worse.
     */
    async status(unit) {
      const name = checkUnit(unit)
      const [path] = await sdk.dbus.systemd('GetUnit', 's', [name])
      const props = ['Description', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState']
      const svc = ['MainPID', 'ExecMainStartTimestamp']

      const head = {}
      for (const p of props) {
        head[p] = await sdk.dbus.get(SYSTEMD, path, `${SYSTEMD}.Unit`, p)
      }
      for (const p of svc) {
        try { head[p] = await sdk.dbus.get(SYSTEMD, path, `${SYSTEMD}.Service`, p) }
        catch { /* not a service unit */ }
      }

      const lines = [
        `${name} - ${head.Description ?? ''}`,
        `   Loaded: ${head.LoadState} (${head.UnitFileState ?? 'n/a'})`,
        `   Active: ${head.ActiveState} (${head.SubState})`,
      ]
      if (head.MainPID) lines.push(` Main PID: ${head.MainPID}`)

      // tier 3 for the log tail only
      const r = await sdk.exec(['journalctl', '-u', name, '-n', '40', '--no-pager', '-o', 'short'])
      return lines.join('\n') + '\n\n' + (r.stdout || r.stderr || '(no journal entries)')
    },

    /**
     * Still tier 3, and on purpose. The bus equivalent is refused by polkit
     * unless a pkttyagent is registered for this ssh session and the call sets
     * ALLOW_INTERACTIVE_AUTHORIZATION — machinery that would replace one line
     * which already works. See plydesk's dbus.rs for the full finding.
     */
    async action(verb, unit) {
      if (!ACTIONS.includes(verb)) throw new Error(`unknown action: ${verb}`)
      const r = await sdk.sudo(['systemctl', verb, checkUnit(unit)])
      if (r.code !== 0) throw new Error(r.stderr.trim() || `${verb} failed (exit ${r.code})`)
      return true
    },
  }
}

export function createApp({ React, html, useApi, useFw }) {
  const { useState, useEffect, useCallback, useMemo, useRef } = React

  return function Services({ setTitle }) {
    const api = useApi()
    const fw = useFw()
    const detailRequest = useRef(0)
    const [units, setUnits] = useState([])
    const [filter, setFilter] = useState('')
    const [onlyRunning, setOnlyRunning] = useState(false)
    const [sel, setSel] = useState(null)
    const [detail, setDetail] = useState('')
    const [err, setErr] = useState('')
    const [busy, setBusy] = useState(false)
    // Push activity, so "working but quiet" is distinguishable from "broken".
    const [live, setLive] = useState(false)
    const [pushes, setPushes] = useState(0)
    const [lastPush, setLastPush] = useState(0)

    const load = useCallback(async () => {
      setBusy(true); setErr('')
      try { setUnits(await api.list()) }
      catch (e) { setErr(String(e)) }
      finally { setBusy(false) }
    }, [api])

    useEffect(() => { load() }, [load])

    // Push, not poll. The backend holds one D-Bus subscription per host and
    // systemd tells us when a job finishes — so starting a service in a
    // terminal updates this list too, with no timer and no round trips.
    //
    // Two things this has to get right that are easy to miss:
    //
    // 1. Signals arrive in bursts. A single ssh login emits UnitNew +
    //    JobRemoved + UnitRemoved for its session scope. Reloading per signal
    //    would mean four full ListUnits calls for one uninteresting event, so
    //    they are coalesced.
    // 2. A refresh that returns identical data is invisible. Without some
    //    indicator, a working push looks exactly like a broken one — which is
    //    precisely how this felt the first time it ran.
    useEffect(() => {
      let mounted = true
      let timer = null

      fw.sys.watchUnits()
        .then(() => { if (mounted) setLive(true) })
        .catch(() => { /* older backend: stay manual */ })

      // JobRemoved carries the unit at args[2]; UnitNew/UnitRemoved at args[0].
      const unitOf = p =>
        p && (p.member === 'JobRemoved' ? p.args?.[2] : p.args?.[0])

      const off = fw.bus.on('units:changed', payload => {
        if (!mounted) return
        setPushes(n => n + 1)
        setLastPush(Date.now())

        // Every ssh login churns a session-N.scope. Counting it as activity is
        // honest; refetching 193 units because of it is not.
        const unit = String(unitOf(payload) ?? '')
        if (!unit.endsWith('.service')) return

        clearTimeout(timer)
        timer = setTimeout(() => { if (mounted) load() }, 250)
      })
      const offStop = fw.bus.on('units:stopped', () => { if (mounted) setLive(false) })

      return () => { mounted = false; clearTimeout(timer); off(); offStop() }
    }, [load])

    // Re-render the "Ns ago" label without re-fetching anything.
    const [, tick] = useState(0)
    useEffect(() => {
      if (!lastPush) return
      const t = setInterval(() => tick(n => n + 1), 1000)
      return () => clearInterval(t)
    }, [lastPush])
    useEffect(() => { setTitle && setTitle('Services') }, [setTitle])

    const rows = useMemo(() => {
      const f = filter.toLowerCase()
      return units
        .filter(u => !onlyRunning || u.sub === 'running')
        .filter(u => !f || u.unit.toLowerCase().includes(f) ||
                     (u.description || '').toLowerCase().includes(f))
        .sort((a, b) => (b.sub === 'running') - (a.sub === 'running') ||
                        a.unit.localeCompare(b.unit))
    }, [units, filter, onlyRunning])

    const act = async verb => {
      if (!sel) return
      setErr(''); setBusy(true)
      try { await api.action(verb, sel.unit); await load() }
      catch (e) { setErr(String(e)) }
      finally { setBusy(false) }
    }

    const show = async u => {
      const request = ++detailRequest.current
      if (sel && sel.unit === u.unit) { setSel(null); setDetail(''); return }
      setSel(u); setDetail('Loading service details…')
      try { const text = await api.status(u.unit); if (request === detailRequest.current) setDetail(text) }
      catch (e) { if (request === detailRequest.current) setDetail(String(e)) }
    }

    const selected = sel ? units.find(u => u.unit === sel.unit) || sel : null
    const closeDetail = () => { detailRequest.current++; setSel(null); setDetail('') }
    const VERBS = ['start', 'stop', 'restart', 'enable', 'disable']

    return html`
      <div class="desk-app sc-root">
        <div class="app-toolbar" role="toolbar" aria-label="Service filters">
          <label class="app-search"><input value=${filter} placeholder="Filter services by name or description"
            aria-label="Filter services" spellCheck=${false} onInput=${e => setFilter(e.target.value)} /></label>
          <label class="app-check"><input type="checkbox" checked=${onlyRunning}
            onChange=${e => setOnlyRunning(e.target.checked)} />Running only</label>
          <span class="app-toolbar-spacer"></span>
          <button class="app-button" onClick=${load} disabled=${busy}>Refresh</button>
        </div>
        ${err && html`<div class="app-notice is-error" role="alert">${err}</div>`}
        <div class="app-split">
          <div class="sc-list">
            <table class="sc-table" aria-label="System services"><thead><tr><th>Service</th><th>Status</th></tr></thead><tbody>
              ${rows.map(u => html`
                <tr key=${u.unit} class=${sel?.unit === u.unit ? 'is-selected' : ''}>
                  <td><button class="sc-service" aria-label=${`Details for ${u.unit}`} aria-pressed=${sel?.unit === u.unit}
                    onClick=${() => show(u)}>
                    <span class=${'sc-service-dot ' + (u.active === 'failed' ? 'is-bad' : u.sub === 'running' ? 'is-good' : '')}></span>
                    <span><strong>${u.unit.replace(/\.service$/, '')}</strong><small>${u.description || u.unit}</small></span>
                  </button></td>
                  <td><span class=${'app-state ' + (u.active === 'failed' ? 'is-bad' : u.sub === 'running' ? 'is-good' : '')}>
                    ${u.sub ? u.sub.charAt(0).toUpperCase() + u.sub.slice(1) : 'Unknown'}</span></td>
                </tr>`)}
            </tbody></table>
            ${!rows.length && html`<div class="app-empty-state" role="status"><h2>${busy ? 'Reading services…' : 'No services found'}</h2>
              <p>${busy ? 'Checking systemd on this machine.' : 'Try another filter or include stopped services.'}</p></div>`}
          </div>
          ${selected && html`
            <aside class="app-inspector sc-inspector" aria-label="Service details">
              <header class="app-inspector-header"><div><h2>${selected.unit}</h2><p>${selected.description}</p></div>
                <button class="app-button is-icon" aria-label="Close service details" title="Back to list" onClick=${closeDetail}>×</button></header>
              <div class="sc-detail-state"><span class=${'app-state ' + (selected.active === 'failed' ? 'is-bad' : selected.sub === 'running' ? 'is-good' : '')}>${selected.active} · ${selected.sub}</span></div>
              <div class="app-inspector-actions" aria-label=${`Actions for ${selected.unit}`}>
                ${VERBS.map(v => html`<button key=${v} class=${'app-button ' + (v === 'stop' ? 'is-danger' : '')}
                  disabled=${busy} onClick=${() => act(v)}>${v.charAt(0).toUpperCase() + v.slice(1)}</button>`)}
              </div>
              <h3 class="sc-log-heading">Status & recent activity</h3>
              <pre class="sc-log">${detail}</pre>
            </aside>`}
        </div>
        <footer class="app-statusbar"><span>${rows.length} of ${units.length} services</span>
          ${busy && html`<span>Refreshing…</span>`}
          <span class="app-status-end sc-live" title=${pushes ? `${pushes} systemd events received; last ${Math.round((Date.now() - lastPush) / 1000)}s ago` : 'Waiting for systemd changes'}>
            ${live && html`<span class="sc-dot"></span>`}${live ? 'Live updates' : 'Manual refresh'}</span>
        </footer>
      </div>`
  }
}
