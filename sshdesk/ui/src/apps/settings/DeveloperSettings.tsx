import { useState, useSyncExternalStore } from 'react'
import { changeDeveloperApps, developerSnapshot, onDeveloperChanged, reloadLocalApp, type DeveloperChange } from '../../ext/loader'
import { APPS } from '../../desktop/registry'
import { useFw } from '../../wm/host'
import { useWM } from '../../wm/store'
import { useDialog } from '../../wm/Dialog'
import { Icon } from '../../wm/Icon'
import { SettingsGroup, SettingsModal, SettingsRow } from './SettingControls'
import './developer.css'

export function DeveloperSettings() {
  const snapshot = useSyncExternalStore(onDeveloperChanged, developerSnapshot)
  const { config, runtime, ready, busy } = snapshot
  const { state } = useWM()
  const fw = useFw()
  const dialog = useDialog()
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [note, setNote] = useState('')
  const [choosing, setChoosing] = useState(false)
  const [openingTools, setOpeningTools] = useState(false)

  const openDevTools = async () => {
    setOpeningTools(true); setError(''); setNote('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('developer_open_devtools')
    } catch (e) { setError(String(e)) }
    finally { setOpeningTools(false) }
  }

  const change = async (value: DeveloperChange) => {
    setError(''); setNote('')
    try { await changeDeveloperApps(value) }
    catch (e) { setError(String(e)) }
  }
  const confirmUnload = async (directories: string[]) => {
    const ids = new Set(directories.map(dir => runtime[dir]?.appId))
    const count = state.wins.filter(w => ids.has(w.appId)).length
    return !count || await dialog.confirm({ title: 'Unload local apps?',
      message: `${count} open ${count === 1 ? 'window uses' : 'windows use'} this code. Save any work first. Apps with a shipped version will return to that version; other local app windows will close.`, okLabel: 'Unload' })
  }
  const browse = async () => {
    setChoosing(true); setLoadError('')
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ title: 'Choose a local sshdesk app', directory: true, multiple: false })
      if (typeof selected === 'string') setPath(selected)
    } catch (e) { setLoadError(String(e)) }
    finally { setChoosing(false) }
  }
  const add = async () => {
    setLoadError('')
    try {
      await changeDeveloperApps({ op: 'add', directory: path })
      setAdding(false); setPath(''); setNote('Folder registered. Load errors, if any, appear below.')
    } catch (e) { setLoadError(String(e)) }
  }

  return <>
    <SettingsGroup title="Development on this Mac">
      <SettingsRow label="Developer mode" description="Load apps directly from your local project folders.">
        <button className="developer-switch" role="switch" aria-checked={config.enabled} aria-label="Developer mode" disabled={!ready || busy}
          onClick={async () => {
            if (config.enabled && !await confirmUnload(config.apps.map(a => a.directory))) return
            await change({ op: 'mode', enabled: !config.enabled })
          }}><span /></button>
      </SettingsRow>
      <SettingsRow label="Developer tools" description="Inspect elements, console output, and JavaScript for the desktop and local apps.">
        <button className="settings-button" disabled={!ready || !config.enabled || busy || openingTools}
          onClick={() => void openDevTools()}><Icon id="lucide:bug" size={14} />{openingTools ? 'Opening…' : 'Open DevTools'}</button>
      </SettingsRow>
    </SettingsGroup>
    <p className="settings-footnote">Local apps run inside sshdesk and can use your connected machines. Only load code you trust.</p>
    {(error || snapshot.error) && <div className="settings-inline-error" role="alert">{error || snapshot.error}</div>}
    {!ready ? <div className="settings-loading" role="status"><span className="ui-spinner" />Loading developer settings…</div> : <>
      <div className="developer-toolbar"><div><h3>Local apps <span>{config.apps.length}</span></h3>
        <p>{config.enabled ? 'Edit in your favorite editor. Reload here.' : 'Enable developer mode to load and run local apps.'}</p></div>
        <button className="settings-button is-primary" disabled={!config.enabled || busy} onClick={() => { setLoadError(''); setAdding(true) }}>
          <Icon id="lucide:folder-plus" size={14} />Load local app…</button>
      </div>
      {config.apps.length === 0 ? <div className="developer-empty">
        <span className="developer-empty-icon"><Icon id="lucide:code-xml" size={26} /></span>
        <strong>Your next app starts here</strong>
        <p>Choose a folder containing <code>index.js</code> and an optional <code>style.css</code>. Your app will join the desktop and dock.</p>
        <span>No sshdesk rebuild needed.</span>
      </div> : <div className="developer-app-list">
        {config.apps.map(entry => {
          const current = runtime[entry.directory]
          const name = current?.name || entry.name || entry.directory.split('/').pop() || 'Local app'
          const active = config.enabled && entry.enabled
          const loaded = !!current?.appId
          const effective = APPS.find(a => a.plugin?.directory === entry.directory && a.plugin.developer)
          const status = !config.enabled ? 'Developer mode off' : !entry.enabled ? 'Disabled' : current?.error ? 'Needs attention' : loaded ? 'Loaded' : 'Not loaded'
          return <section key={entry.directory} className="developer-app" aria-label={`${name} local app`}>
            <div className="developer-app-heading"><span className="settings-app-icon app-tile"><Icon id={current?.icon || entry.icon || 'lucide:code-xml'} size={21} /></span>
              <div><strong>{name}</strong><span className={`developer-app-status ${active && !current?.error && loaded ? 'is-ready' : current?.error ? 'has-error' : ''}`}>
                <span className="status-dot" />{status}{active && loaded && entry.watch && !current?.error ? ' · Watching for changes' : ''}</span></div>
              <button className="developer-switch" role="switch" aria-checked={entry.enabled} aria-label={`Enable ${name}`} disabled={!config.enabled || busy}
                onClick={async () => {
                  if (entry.enabled && !await confirmUnload([entry.directory])) return
                  await change({ op: 'update', directory: entry.directory, enabled: !entry.enabled })
                }}><span /></button>
            </div>
            <code className="developer-app-path">{entry.directory}</code>
            {current?.error && <div className="developer-app-error" role="alert"><strong>{current.errorStage === 'render' ? 'The app stopped' : loaded ? 'Reload failed' : 'Couldn’t load this app'}</strong>
              <p>{current.error}</p><small>{current.errorStage === 'render' ? 'Fix the error and reload to restart this app.' : loaded ? 'The previous version is still running. Fix the error and reload.' : 'Fix the entry file or build output, then reload.'}</small></div>}
            <div className="developer-app-actions">
              <label className="developer-watch"><input type="checkbox" checked={entry.watch} disabled={!active || busy}
                onChange={e => void change({ op: 'update', directory: entry.directory, watch: e.target.checked })} />Reload on changes</label>
              <div><button className="settings-button" disabled={!effective || busy} onClick={() => fw.ui.open(effective!.id)}>Open</button>
                <button className="settings-button" disabled={!active || busy} aria-label={`Reload ${name}`} onClick={async () => {
                  setError(''); setNote('')
                  try { await reloadLocalApp(entry.directory); setNote(`${name}: reload finished.`) } catch (e) { setError(String(e)) }
                }}><Icon id="lucide:rotate-cw" size={12} />Reload</button>
                <button className="settings-icon-button" aria-label={`Remove ${name} registration`} title="Remove registration" disabled={busy} onClick={async () => {
                  if (!await confirmUnload([entry.directory])) return
                  await change({ op: 'remove', directory: entry.directory })
                }}><Icon id="lucide:trash-2" size={14} /></button></div>
            </div>
            {current?.loadedAt && <div className="developer-app-time">Loaded at {new Date(current.loadedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>}
          </section>
        })}
      </div>}
      {note && <p className="settings-footnote" role="status">{note}</p>}
      <p className="settings-footnote">Reloading restarts the app’s content and resets temporary state. Its windows keep their position and size. Removing a registration keeps your source files.</p>
      <details className="settings-technical developer-guide"><summary>App structure & build setup</summary>
        <p>Export <code>manifest</code> and <code>createApp</code> from <code>index.js</code>. Use the React instance and desktop APIs passed to <code>createApp</code>.</p>
        <pre>{`my-app/\n  index.js    # JavaScript module\n  style.css   # Optional app styles`}</pre>
        <p>For JSX or TypeScript, run your bundler in watch mode and choose its output folder. Bundle dependencies into <code>index.js</code>; relative module imports and asset paths are not resolved by this loader.</p>
        <p>Use a unique app ID. A local app with the same ID as a shipped extension temporarily replaces it while enabled.</p>
      </details>
    </>}
    {adding && <SettingsModal title="Load local app" onClose={() => { if (!busy && !choosing) setAdding(false) }} wide>
      <div className="settings-modal-body">
        <p className="developer-load-description">Choose your app’s folder on this Mac. sshdesk remembers this location and reads your code directly from it.</p>
        <label className="settings-editor-field" htmlFor="developer-app-folder">App folder</label>
        <div className="developer-folder-input"><input id="developer-app-folder" data-autofocus value={path} placeholder="~/Projects/my-app" spellCheck={false}
          disabled={busy || choosing} onChange={e => setPath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && path.trim() && !busy) void add() }} />
          <button className="settings-button" disabled={busy || choosing} onClick={() => void browse()}>Browse…</button></div>
        <p className="settings-footnote">The folder must contain <code>index.js</code>. If you use a build step, select the folder containing its compiled output.</p>
        {loadError && <div className="settings-inline-error" role="alert">{loadError}</div>}
      </div>
      <footer><button className="settings-button" disabled={busy || choosing} onClick={() => setAdding(false)}>Cancel</button>
        <button className="settings-button is-primary" disabled={!path.trim() || busy || choosing} onClick={() => void add()}>{busy ? 'Loading…' : 'Load app'}</button></footer>
    </SettingsModal>}
  </>
}
