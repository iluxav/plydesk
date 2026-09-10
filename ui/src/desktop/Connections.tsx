import { useRef, useState } from 'react'
import { fw, type SavedConn } from '../fw'
import { Icon } from '../wm/Icon'
import { useContextMenu } from '../wm/ContextMenu'

export function Connections({ onConnected, connected = [], onCancel }: {
  onConnected: (target: string) => void
  connected?: string[]
  onCancel?: () => void
}) {
  const menu = useContextMenu()
  const [saved, setSaved] = useState<SavedConn[]>(() => fw.conns.list())
  const initial = saved.find(c => !connected.includes(`${c.user}@${c.host}`))
  const [selected, setSelected] = useState(initial ? `${initial.user}@${initial.host}` : '')
  const [form, setForm] = useState({ host: initial?.host ?? '', user: initial?.user ?? '', password: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const connecting = useRef(false)
  const hostInput = useRef<HTMLInputElement>(null)
  const machine = saved.find(c => `${c.user}@${c.host}` === selected)

  const choose = (conn?: SavedConn) => {
    if (connecting.current) return
    setSelected(conn ? `${conn.user}@${conn.host}` : '')
    setForm({ host: conn?.host ?? '', user: conn?.user ?? '', password: '' })
    setErr('')
    if (!conn) requestAnimationFrame(() => hostInput.current?.focus())
  }

  const connect = async () => {
    if (connecting.current) return
    const user = form.user.trim(), host = form.host.trim()
    if (!user || !host) return
    const target = `${user}@${host}`
    connecting.current = true
    setBusy(true); setErr('')
    try {
      await fw.host.connect(target, form.password || undefined)
      const name = await fw.for(target).dbus
        .get('org.freedesktop.hostname1', '/org/freedesktop/hostname1',
          'org.freedesktop.hostname1', 'Hostname')
        .then(v => typeof v === 'string' && v ? v : undefined)
        .catch(() => undefined)
      fw.conns.remember(user, host, name)
      setSaved(fw.conns.list())
      onConnected(target)
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ''))
    } finally { connecting.current = false; setBusy(false) }
  }

  const forget = (c: SavedConn) => {
    fw.conns.forget(c.user, c.host)
    setSaved(fw.conns.list())
    if (selected === `${c.user}@${c.host}`) choose()
  }

  return (
    <main className="connection-screen" onKeyDown={e => {
      if (e.key === 'Escape' && onCancel && !busy) { e.preventDefault(); onCancel() }
    }}>
      <div className="connection-titlebar" data-tauri-drag-region>
        <span>plydesk</span><span className="connection-titlebar-label">Remote desktop</span>
        {onCancel && <button className="subtle-button" onClick={onCancel} disabled={busy}>
          <Icon id="lucide:arrow-left" size={14} /> Back to desktop
        </button>}
      </div>
      <div className="connection-workspace">
        <header className="connection-heading">
          <div className="connection-mark"><Icon id="desk:terminal" fallback="⌘" size={24} /></div>
          <div><h1>Your machines. Your workspace.</h1>
            <p>Files, terminals, and tools. One desktop, over SSH.</p></div>
        </header>
        <section className="connection-panel" aria-label="Connect to a machine">
          <aside className="machine-sidebar">
            <div className="machine-sidebar-heading"><span>Machines</span><span>{saved.length}</span></div>
            <div className="machine-list">
              {saved.map(c => {
                const target = `${c.user}@${c.host}`
                const already = connected.includes(target)
                return <div key={target} className={`machine-row ${selected === target ? 'is-selected' : ''}`}>
                  <button className="machine-select" disabled={busy || already}
                    aria-pressed={selected === target} onClick={() => choose(c)}
                    onContextMenu={e => menu.open(e, [
                      { label: 'Connect', disabled: busy || already, onSelect: () => choose(c) },
                      { type: 'separator' },
                      { label: 'Forget connection', disabled: busy || already, danger: true, onSelect: () => forget(c) },
                    ])}>
                    <span className="machine-icon"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4.5h16v11H4zM12 15.5v4M8 19.5h8" /></svg></span>
                    <span className="machine-copy"><strong>{c.name || c.host}</strong>
                      <span>{c.user}@{c.host}</span>
                      {already && <small className="text-desk-ok">Connected</small>}
                    </span>
                  </button>
                  {!already && <button className="machine-forget" disabled={busy}
                    aria-label={`Forget ${c.name || c.host}`} title="Forget connection" onClick={() => forget(c)}>
                    <Icon id="lucide:x" size={13} />
                  </button>}
                </div>
              })}
              {!saved.length && <p className="machine-empty">Your saved machines will appear here.</p>}
            </div>
            <button className={`machine-add ${!selected ? 'is-selected' : ''}`} disabled={busy} onClick={() => choose()}>
              <Icon id="lucide:plus" size={16} /> Add a machine
            </button>
            <div className="machine-sidebar-footer"><Icon id="lucide:laptop" size={14} /> Connected from this Mac</div>
          </aside>
          <form className="connection-form" aria-busy={busy}
            onSubmit={e => { e.preventDefault(); void connect() }}>
            <div className="connection-form-heading">
              <span className="connection-eyebrow">{machine ? 'Saved machine' : 'New connection'}</span>
              <h2>{machine?.name || machine?.host || (saved.length ? 'Connect another machine' : 'Add your first connection')}</h2>
              <p>{machine ? 'Pick up where you left off.' : 'Connect to any machine you can reach over SSH.'}</p>
            </div>
            <fieldset disabled={busy} className="connection-fields">
              <label>Host or IP address
                <input ref={hostInput} value={form.host} required autoComplete="off" spellCheck={false}
                  placeholder="192.168.1.10 or my-server" onChange={e => setForm({ ...form, host: e.target.value })} />
              </label>
              <label>Username
                <input value={form.user} required autoComplete="username" spellCheck={false}
                  placeholder="Your remote username" onChange={e => setForm({ ...form, user: e.target.value })} />
              </label>
              <label><span>Password <span className="field-optional">Optional</span></span>
                <input type="password" value={form.password} autoComplete="off"
                  placeholder="Leave empty to use your SSH key" onChange={e => setForm({ ...form, password: e.target.value })} />
              </label>
            </fieldset>
            {err && <div className="connection-error" role="alert"><strong>Couldn’t connect</strong><span>{err}</span></div>}
            <button type="submit" className="connection-submit" disabled={busy || !form.host.trim() || !form.user.trim()}>
              {busy ? <><span className="ui-spinner" /> Connecting…</> : <><span>Connect to machine</span><Icon id="lucide:arrow-right" size={16} /></>}
            </button>
            <p className="connection-security"><Icon id="lucide:key-round" size={13} /> Passwords are never saved.</p>
          </form>
        </section>
        <footer className="connection-footer"><span className="status-dot" /> Your SSH connection. Nothing to install on the remote.</footer>
      </div>
    </main>
  )
}
