import { useEffect, useState } from 'react'
import { fw } from '../fw'
import { Icon } from '../wm/Icon'
import { IconPicker, SettingsModal } from '../apps/settings/SettingControls'
import { newShortcut, type Shortcut, type ShortcutKind } from './model'
import { saveShortcut, shortcuts } from './store'
import '../apps/settings/settings.css'
import './shortcuts.css'

export function ShortcutManager({ host }: { host: string }) {
  const [editing, setEditing] = useState<{ shortcut?: Shortcut; kind?: ShortcutKind } | null>(null)
  useEffect(() => {
    const open = (event: Event) => {
      const { id, kind } = (event as CustomEvent).detail || {}
      setEditing({ shortcut: id ? shortcuts().find(s => s.id === id) : undefined, kind })
    }
    window.addEventListener('plydesk:edit-shortcut', open)
    return () => window.removeEventListener('plydesk:edit-shortcut', open)
  }, [])
  return editing && <ShortcutEditor key={editing.shortcut?.id || editing.kind || 'new'} host={host}
    initial={editing.shortcut} initialKind={editing.kind} onClose={() => setEditing(null)} />
}
function ShortcutEditor({ host, initial, initialKind, onClose }: { host: string; initial?: Shortcut; initialKind?: ShortcutKind; onClose: () => void }) {
  const [kind, setKind] = useState<ShortcutKind | null>(initial?.kind || initialKind || null)
  const [draft, setDraft] = useState<Shortcut>(initial || newShortcut(initialKind || 'web', host))
  const [origins, setOrigins] = useState(initial?.kind === 'web' ? initial.allowedOrigins.join('\n') : '')
  const [iconPicker, setIconPicker] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const choose = (kind: ShortcutKind) => { setKind(kind); setDraft(newShortcut(kind, host)); setError('') }
  const machines = fw.conns.list().map(c => ({ id: `${c.user}@${c.host}`, name: c.name || c.host }))
  if (!machines.some(m => m.id === host)) machines.push({ id: host, name: host })
  if (draft.kind === 'tui' && !machines.some(m => m.id === draft.machine)) machines.push({ id: draft.machine, name: draft.machine })
  const submit = async (open: boolean) => {
    setBusy(true); setError('')
    try {
      const value = draft.kind === 'web' ? { ...draft, url: draft.url.trim(), allowedOrigins: origins.split(/\n|,/).map(s => s.trim()).filter(Boolean) } : draft
      const saved = await saveShortcut(value)
      onClose()
      if (open) fw.ui.open(saved.id, { host: saved.kind === 'tui' ? saved.machine : host })
    } catch (e) { setError(String(e).replace(/^Error:\s*/, '')); setBusy(false) }
  }
  return <>
    <SettingsModal title={initial ? `Edit ${initial.name}` : 'Create app shortcut'} onClose={() => { if (!busy) onClose() }} wide>
      {!kind ? <div className="shortcut-choices">
        <p>Add a website or a terminal tool to your dock and launcher.</p>
        <button onClick={() => choose('web')}><Icon id="lucide:globe" size={26} /><span><strong>Web app shortcut</strong><small>A website in its own window, without an address bar.</small></span><Icon id="lucide:chevron-right" size={16} /></button>
        <button onClick={() => choose('tui')}><Icon id="lucide:terminal" size={26} /><span><strong>TUI shortcut</strong><small>A terminal command on one of your SSH machines.</small></span><Icon id="lucide:chevron-right" size={16} /></button>
      </div> : <form className="shortcut-editor" onSubmit={e => { e.preventDefault(); void submit(false) }}>
        <div className="shortcut-form">
          <div className="shortcut-identity"><button type="button" className={`shortcut-icon app-tile app-tile-${kind === 'web' ? 'ports' : 'terminal'}`} aria-label="Choose shortcut icon" onClick={() => setIconPicker(true)}><Icon id={draft.icon} size={28} /></button>
            <label>Name<input autoFocus data-autofocus required maxLength={120} placeholder={kind === 'web' ? 'Project dashboard' : 'System monitor'} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label></div>
          {draft.kind === 'web' ? <>
            <label>Website URL<input required type="url" placeholder="https://example.com" value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} autoCapitalize="none" spellCheck={false} /></label>
            <p>Available on every machine’s desktop. External links open in your Mac’s browser. Website sign-ins are remembered.</p>
            <details><summary>Additional domains</summary><label>Keep these domains inside this app<textarea value={origins} onChange={e => setOrigins(e.target.value)} placeholder="https://login.example.com" spellCheck={false} rows={3} /></label><p>For sign-in redirects or related pages. Use one complete origin per line. Links that open a new window go to your browser.</p></details>
          </> : <>
            <label>Machine<select value={draft.machine} onChange={e => setDraft({ ...draft, machine: e.target.value })}>{machines.map(m => <option key={m.id} value={m.id}>{m.name} · {m.id}</option>)}</select></label>
            <label>Command<input required placeholder="htop" value={draft.command} onChange={e => setDraft({ ...draft, command: e.target.value })} spellCheck={false} autoCapitalize="none" className="shortcut-command" /></label>
            <label>Working directory <span className="shortcut-optional">Optional</span><input placeholder="~ or ~/projects/my-app" value={draft.cwd} onChange={e => setDraft({ ...draft, cwd: e.target.value })} spellCheck={false} autoCapitalize="none" /></label>
            <p>Runs as your SSH user through the remote login shell. The window closes when the command finishes; errors stay visible.</p>
            <label className="shortcut-check"><input type="checkbox" checked={draft.closeOnCtrlC} onChange={e => setDraft({ ...draft, closeOnCtrlC: e.target.checked })} /><span>Always close the window on Ctrl-C<small>Otherwise, Ctrl-C is handled by the terminal app.</small></span></label>
          </>}
          {initial && <p>Changes apply the next time you open this shortcut.</p>}
          {error && <div className="settings-inline-error" role="alert">{error}</div>}
        </div>
        <footer>{!initial && <button type="button" className="settings-button" disabled={busy} onClick={() => setKind(null)}>Back</button>}<span className="shortcut-spacer" />
          <button type="button" className="settings-button" disabled={busy} onClick={onClose}>Cancel</button>
          {!initial && <button type="button" className="settings-button" disabled={busy || !draft.name.trim() || !(draft.kind === 'web' ? draft.url : draft.command).trim()} onClick={() => void submit(true)}>Create & open</button>}
          <button className="settings-button is-primary" disabled={busy}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Create shortcut'}</button>
        </footer>
      </form>}
    </SettingsModal>
    {iconPicker && <IconPicker title="Shortcut icon" current={draft.icon} onClose={() => setIconPicker(false)} onPick={async icon => { setDraft({ ...draft, icon }); setIconPicker(false) }} disabled={false} />}
  </>
}
