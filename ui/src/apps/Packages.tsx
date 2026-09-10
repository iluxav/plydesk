import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useFw } from '../wm/host'
import { Icon } from '../wm/Icon'
import type { PkgItem, PkgDetails } from '../fw'

/**
 * Packages.
 *
 * Reads come from PackageKit over the bus, so they are typed and the same code
 * works on apt, dnf or zypper without knowing which. Writes go through
 * `sudo pkcon` for the same reason systemd writes go through `sudo systemctl`:
 * PackageKit gates installs behind polkit, and root is not subject to it.
 */

type Tab = 'search' | 'installed' | 'updates'

export function Packages({ setTitle }: { setTitle?: (t: string) => void }) {
  const fw = useFw()
  const [tab, setTab] = useState<Tab>('installed')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<PkgItem[]>([])
  const [sel, setSel] = useState<PkgItem | null>(null)
  const [details, setDetails] = useState<PkgDetails | null>(null)
  const [backend, setBackend] = useState('')
  const [busy, setBusy] = useState(false)
  const [working, setWorking] = useState('')
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  const [detailsError, setDetailsError] = useState('')

  useEffect(() => { setTitle?.('Packages') }, [setTitle])

  useEffect(() => {
    fw.pkg.backend().then(setBackend).catch(() => setBackend(''))
  }, [fw])

  const loadTab = useCallback(async (which: Tab, q = '') => {
    const current = ++request.current
    setBusy(true); setErr(''); setNote(''); setSel(null); setDetails(null)
    try {
      const list = which === 'installed' ? await fw.pkg.installed()
                 : which === 'updates'   ? await fw.pkg.updates()
                 : q.trim() ? await fw.pkg.search(q.trim()) : []
      if (current !== request.current) return
      setItems(list)
      if (which === 'search' && q && list.length === 0) setNote(`nothing matches “${q}”`)
    } catch (e) { if (current === request.current) { setErr(String(e)); setItems([]) } }
    finally { if (current === request.current) setBusy(false) }
  }, [fw])

  useEffect(() => { loadTab('installed') }, [loadTab])

  // Details are a second round trip, so they are fetched on selection rather
  // than for every row in a 700-item list.
  useEffect(() => {
    if (!sel) return
    let live = true
    setDetails(null); setDetailsError('')
    fw.pkg.details(sel.id).then(d => { if (live) setDetails(d) })
      .catch(e => { if (live) setDetailsError(String(e)) })
    return () => { live = false }
  }, [fw, sel])

  const act = async (pkg: PkgItem, verb: 'install' | 'remove') => {
    if (verb === 'remove' && !await fw.ui.confirm({ title: `Remove ${pkg.name}?`, message: 'This uninstalls the package from this machine.', okLabel: 'Remove', danger: true })) return
    const password = await fw.sys.sudoPassword(
      `Needed to ${verb} ${pkg.name} on this machine`)
    if (!password) return
    setWorking(`${verb === 'install' ? 'installing' : 'removing'} ${pkg.name}…`)
    setErr(''); setNote('')
    try {
      const msg = verb === 'install'
        ? await fw.pkg.install(pkg.name, password)
        : await fw.pkg.remove(pkg.name, password)
      // The list is now stale by definition, so re-read rather than patch it.
      await loadTab(tab, query)
      setNote(msg)
    } catch (e) {
      const text = String(e)
      if (/password|authentic/i.test(text)) fw.sys.forgetPassword()
      setErr(text)
    } finally { setWorking('') }
  }

  const refresh = async () => {
    const password = await fw.sys.sudoPassword('Needed to refresh the package index')
    if (!password) return
    setWorking('refreshing the package index…'); setErr('')
    try { setNote(await fw.pkg.refresh(password)) }
    catch (e) { setErr(String(e)) } finally { setWorking('') }
  }

  const rows = useMemo(() => tab === 'search' || !query.trim() ? items : items.filter(p =>
    `${p.name} ${p.summary}`.toLowerCase().includes(query.trim().toLowerCase())), [items, query, tab])
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 61,
    overscan: 12,
  })


  return (
    <div className="desk-app packages-app">
      <div className="app-toolbar" role="toolbar" aria-label="Package browser">
        <div className="app-segmented" aria-label="Package collection">
          {(['installed', 'search', 'updates'] as Tab[]).map(k => <button key={k} aria-pressed={tab === k}
            disabled={!!working} onClick={() => { setTab(k); setQuery(''); void loadTab(k) }}>
            {k === 'installed' ? 'Installed' : k === 'search' ? 'Discover' : 'Updates'}</button>)}
        </div>
        <label className="app-search"><Icon id="desk:search" size={14} />
          <input value={query} aria-label={tab === 'search' ? 'Search packages' : 'Filter packages'} spellCheck={false}
            placeholder={tab === 'search' ? 'Search packages, then Return' : 'Filter by name or description'}
            onChange={e => setQuery(e.target.value)} onKeyDown={e => {
              if (e.key === 'Enter' && tab === 'search') void loadTab('search', query)
              if (e.key === 'Escape') setQuery('')
            }} /></label>
        {tab === 'search' && <button className="app-button" disabled={busy || !!working || !query.trim()}
          onClick={() => void loadTab('search', query)}>Search</button>}
        <button className="app-button" onClick={() => void refresh()} disabled={!!working || busy}
          title="Refresh the remote package index">Refresh index</button>
      </div>
      {err && <div className="app-notice is-error" role="alert">{err}</div>}
      <div className="app-split">
        <div ref={scroller} className="packages-list" aria-label="Packages">
          {busy ? <div className="app-empty-state" role="status"><span className="ui-spinner" /><p>Reading packages…</p></div>
            : <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
              {virt.getVirtualItems().map(v => {
                const p = rows[v.index]
                return <button key={p.id} className="package-row" aria-pressed={sel?.id === p.id}
                  aria-label={`Details for ${p.name}`} onClick={() => setSel(p)}
                  style={{ height: v.size, transform: `translateY(${v.start}px)` }}>
                  <span><Icon token={p.installed ? 'packages.installed' : 'packages.available'} host={fw.host.current()} size={17} /></span>
                  <span><strong>{p.name}<span className="package-version">{p.version}</span></strong><small>{p.summary}</small></span>
                  <Icon id="desk:chevron-right" size={14} />
                </button>
              })}
            </div>}
          {!busy && !rows.length && <div className="app-empty-state">
            <span className="app-empty-mark"><Icon id="desk:app" size={28} /></span>
            <h2>{query.trim() ? 'No packages found' : tab === 'search' ? 'Find software for this machine' : tab === 'updates' ? 'No updates available' : 'No packages to show'}</h2>
            <p>{query.trim() ? 'Try another name or a shorter search.' : tab === 'search' ? 'Search your machine’s package repositories by name.' : tab === 'updates' ? 'The current package index has no pending updates.' : 'Installed packages will appear here.'}</p>
          </div>}
        </div>
        {sel && <aside className="app-inspector" aria-label="Package details">
          <header className="app-inspector-header"><div><h2>{sel.name}</h2><p className="app-mono">{sel.version} · {sel.arch}</p></div>
            <button className="app-button is-icon" aria-label="Close package details" onClick={() => setSel(null)}><Icon id="lucide:x" size={14} /></button></header>
          <div className="app-inspector-actions"><span className={`app-state ${sel.installed ? 'is-good' : ''}`}>{sel.installed ? 'Installed' : tab === 'updates' ? 'Update available' : 'Available'}</span>
            <span className="app-toolbar-spacer" />
            <button className={`app-button ${sel.installed ? 'is-danger' : 'is-primary'}`} disabled={!!working}
              onClick={() => void act(sel, sel.installed ? 'remove' : 'install')}>{sel.installed ? 'Remove…' : 'Install…'}</button></div>
          <div className="app-inspector-body"><p>{sel.summary}</p>
            {details ? <>
              {details.description && <p className="package-description">{details.description}</p>}
              <dl>{details.size > 0 && <><dt>Size</dt><dd>{fw.fmt.size(details.size)}</dd></>}
                {details.license && details.license !== 'unknown' && <><dt>License</dt><dd>{details.license}</dd></>}
                <dt>Repository</dt><dd>{sel.repo || 'Not specified'}</dd>
                {details.url && <><dt>Website</dt><dd>{details.url}</dd></>}
              </dl></> : detailsError ? <p role="alert" className="text-desk-bad">{detailsError}</p> : <p className="app-dim" role="status">Loading details…</p>}
          </div>
        </aside>}
      </div>
      <footer className="app-statusbar" role="status"><span>{rows.length.toLocaleString()} {tab === 'updates' ? 'updates' : 'packages'}</span>
        {working ? <><span className="ui-spinner" /><span>{working}</span></> : note && <span className="truncate">{note}</span>}
        {backend && <span className="app-status-end">{backend} · {fw.host.current().split('@').at(-1)}</span>}
      </footer>
    </div>
  )
}
