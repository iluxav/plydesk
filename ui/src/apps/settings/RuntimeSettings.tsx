import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { SettingsGroup, SettingsRow } from './SettingControls'
import { useWM } from '../../wm/store'
import { useDialog } from '../../wm/Dialog'
import { Icon } from '../../wm/Icon'
import { ACCESS } from '../../ext/permissions'
import type { AppDef } from '../../desktop/registry'
import type { RuntimeInfo } from '../../ext/runtimeEvents'

export function RunningApps({ developer }: { developer: boolean }) {
  const [views, setViews] = useState<RuntimeInfo[]>([])
  const [error,setError] = useState('')
  const { dispatch } = useWM()
  useEffect(() => {
    let live = true, stop: (() => void) | undefined
    const refresh = () => { void invoke<RuntimeInfo[]>('runtime_list').then(v => { if (live) setViews(v) }).catch(e => { if (live) setError(String(e)) }) }
    void listen('app-runtimes-changed', refresh).then(off => { if (live) { stop = off; refresh() } else off() })
    return () => { live = false; stop?.() }
  }, [])
  return <SettingsGroup title={`Running app windows · ${views.length}`}>
    {!views.length && <p className="settings-empty">No JavaScript apps are running. Installed apps start when you open them.</p>}
    {views.map(v => <SettingsRow key={v.label} label={v.name} description={v.host}>
      <button className="settings-button" disabled={!developer} title={developer ? `Inspect ${v.name}` : 'Enable Developer mode to inspect apps'}
        onClick={() => { void invoke('runtime_devtools', { label:v.label }).catch(e => setError(String(e))) }}><Icon id="lucide:bug" size={13} />Inspect</button>
      <button className="settings-button" onClick={() => { dispatch({t:'close',id:v.winId}); void invoke('runtime_close',{label:v.label}).catch(e => setError(String(e))) }}>Close</button>
    </SettingsRow>)}
    {error && <p className="settings-inline-error" role="alert">{error}</p>}
  </SettingsGroup>
}
export function AppAccess({ app }: { app: AppDef }) {
  const [error,setError] = useState(''), [note,setNote] = useState('')
  const { state, dispatch } = useWM()
  const dialog = useDialog()
  const revoke = async () => {
    if (!await dialog.confirm({title:`Revoke ${app.title} access?`,message:'This closes its open windows on all machines. The app will ask for access the next time you open it.',okLabel:'Revoke access'})) return
    try {
      await invoke('runtime_revoke',{directory:app.plugin!.directory})
      state.wins.filter(w => w.appId === app.id).forEach(w => dispatch({t:'close',id:w.id}))
      setNote('Access revoked. This app will ask again when opened.'); setError('')
    } catch(e) { setError(String(e)) }
  }
  return <SettingsGroup title="Requested access">
    {(app.plugin?.permissions || []).map(p => <SettingsRow key={p} label={ACCESS[p]?.[0] || p} description={ACCESS[p]?.[1]}>{null}</SettingsRow>)}
    {!app.plugin?.permissions?.length && <p className="settings-empty">This app requests no machine or network access.</p>}
    <SettingsRow label="Saved approvals" description="Access is approved separately for each machine."><button className="settings-button" onClick={() => void revoke()}>Revoke access…</button></SettingsRow>
    {note && <p className="settings-footnote" role="status">{note}</p>}
    {error && <p className="settings-inline-error" role="alert">{error}</p>}
  </SettingsGroup>
}
