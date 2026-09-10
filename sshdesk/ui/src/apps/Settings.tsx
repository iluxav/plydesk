import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useFw } from '../wm/host'
import { useWM } from '../wm/store'
import { useDialog } from '../wm/Dialog'
import { APPS, type AppDef } from '../desktop/registry'
import { Icon } from '../wm/Icon'
import { configKey, declarations, machineConfig, onTokensChanged, resolve, setConfig, setValue, type TokenDecl } from '../fw/tokens'
import { onPluginsChanged, pluginFailures, reloadPlugins } from '../ext/loader'
import { SettingsGroup, SettingsModal, SettingsRow, TokenSetting, type SaveSetting } from './settings/SettingControls'
import './settings/settings.css'
import { KeyboardSettings } from './settings/KeyboardSettings'
import { DeveloperSettings } from './settings/DeveloperSettings'

const PAGES = [
  { id: 'appearance', title: 'Appearance', icon: 'lucide:palette', description: 'Colors, window style, and the look of your desktop.' },
  { id: 'wallpaper', title: 'Wallpaper', icon: 'lucide:mountain', description: 'Make this machine’s workspace your own.' },
  { id: 'keyboard', title: 'Keyboard', icon: 'lucide:keyboard', description: 'Keyboard shortcuts, window snapping, and switching between apps.' },
  { id: 'apps', title: 'Apps & Extensions', icon: 'desk:app', description: 'Your desktop apps, including JavaScript extensions.' },
  { id: 'tools', title: 'Remote Tools', icon: 'lucide:hard-drive', description: 'Supporting software installed by sshdesk on this machine.' },
  { id: 'developer', title: 'Developer', icon: 'lucide:code-xml', description: 'Build, load, and reload local apps without rebuilding sshdesk.' },
  { id: 'advanced', title: 'Advanced', icon: 'lucide:sliders-horizontal', description: 'Configuration and customization for this workspace.' },
]
const ACCENTS = [
  ['Blue', '#60a5fa'], ['Teal', '#5bbfb5'], ['Green', '#84b88b'], ['Amber', '#d9b16e'],
  ['Orange', '#df9c72'], ['Rose', '#d990aa'], ['Lilac', '#ac9bdb'], ['Graphite', '#a3afbf'],
]
const APPEARANCE_GROUPS = [
  { title: 'Desktop colors', names: ['bg', 'panel', 'fg', 'dim', 'selection'] },
  { title: 'Windows & dock', names: ['menubar', 'dock', 'titlebar', 'border', 'line'] },
  { title: 'Status colors', names: ['ok', 'bad', 'warn'] },
]
const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  files: 'Browse and organize files on your machine.', terminal: 'An interactive shell over your SSH connection.',
  editor: 'Read and edit text and source files.', image: 'View images from your machine.',
  settings: 'Personalize your desktop and applications.', packages: 'Find and manage system packages.',
}

type Section = string
type Tool = { name: string; size: number }

export function Settings({ setTitle }: { setTitle?: (title: string) => void }) {
  const fw = useFw()
  const host = fw.host.current()
  const machine = fw.conns.list().find(c => `${c.user}@${c.host}` === host)
  const machineName = machine?.name || host.split('@').at(-1) || 'This machine'
  const { state, dispatch } = useWM()
  const dialog = useDialog()
  const [section, setSection] = useState<Section>('appearance')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'builtin' | 'extensions'>('all')
  const [customizing, setCustomizing] = useState(false)
  const [installHelp, setInstallHelp] = useState(false)
  const [pending, setPending] = useState(0)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [tools, setTools] = useState<Tool[] | null>(null)
  const [toolsError, setToolsError] = useState('')
  const [configPath, setConfigPath] = useState('')
  const [preview, setPreview] = useState({ path: '', url: '' })
  const [, render] = useState(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const content = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const toolRequest = useRef(0)
  const busy = pending > 0
  const apps = APPS.slice().sort((a, b) => a.title.localeCompare(b.title))
  const activeApp = section.startsWith('app:') ? apps.find(app => app.id === section.slice(4)) : undefined
  const appTokens = declarations().find(([id]) => id === activeApp?.id)?.[1] ?? {}
  const deskTokens = declarations().find(([id]) => id === 'desk')?.[1] ?? {}
  const page = PAGES.find(page => page.id === section) ?? PAGES[3]
  const picture = resolve('desk.wallpaper', host).value
  const pictureUrl = preview.path === picture ? preview.url : ''
  const read = (name: string) => resolve(`desk.${name}`, host).value

  useEffect(() => { setTitle?.('Settings') }, [setTitle])
  useEffect(() => onTokensChanged(() => render(n => n + 1)), [])
  useEffect(() => onPluginsChanged(() => render(n => n + 1)), [])
  useEffect(() => {
    const search = (event: KeyboardEvent) => {
      const field = searchInput.current
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f' || !field?.getClientRects().length) return
      if (!field.closest('[data-window][data-focused="true"]') || document.querySelector('[aria-modal="true"]')) return
      event.preventDefault()
      field.focus(); field.select()
    }
    window.addEventListener('keydown', search)
    return () => window.removeEventListener('keydown', search)
  }, [])
  useEffect(() => {
    let live = true
    if (picture) fw.wallpaper(picture).then(url => { if (live) setPreview({ path: picture, url }) })
      .catch(() => { if (live) setPreview({ path: picture, url: '' }) })
    return () => { live = false }
  }, [fw, picture])
  useEffect(() => {
    let live = true
    fw.config.path().then(path => { if (live) setConfigPath(path) }).catch(() => {})
    return () => { live = false }
  }, [fw])

  // Serialize writes and update the shared token store only after persistence.
  // Desktop owns theme application, including the other connected machines.
  const save: SaveSetting = useCallback((id, decl, value) => {
    setPending(n => n + 1); setError(''); setNote('')
    const task = queue.current.then(async () => {
      try {
        if (!host) throw new Error('Connect to a machine to change its settings.')
        const key = configKey(id, decl.type)
        await fw.config.set(key, value, host)
        setValue(key, value, host)
        setNote(value === undefined ? `${decl.label} restored to default` : 'Changes saved')
        return true
      } catch (e) { setError(String(e).replace(/^Error:\s*/, '')); return false }
      finally { setPending(n => n - 1) }
    })
    queue.current = task
    return task
  }, [fw, host])

  const loadTools = useCallback(async () => {
    const request = ++toolRequest.current
    setTools(null); setToolsError('')
    try { const result = await fw.deps.installed(); if (request === toolRequest.current) setTools(result) }
    catch (e) { if (request === toolRequest.current) setToolsError(String(e)) }
  }, [fw])
  useEffect(() => {
    if (section === 'tools') void loadTools()
    return () => { toolRequest.current++ }
  }, [section, loadTools])

  const navigate = (next: Section, token = '') => {
    setSection(next); setQuery('')
    if (token.startsWith('desk.') && !['desk.accent', 'desk.radius', 'desk.wallpaper', 'desk.tint'].includes(token)) setCustomizing(true)
    content.current?.scrollTo({ top: 0 })
    requestAnimationFrame(() => {
      if (token) {
        const row = content.current?.querySelector<HTMLElement>(`[data-setting="${CSS.escape(token)}"]`)
        row?.scrollIntoView({ block: 'center' })
        row?.setAttribute('tabindex', '-1')
        row?.focus({ preventScroll: true })
      }
    })
  }
  const reload = async () => {
    const open = state.wins.filter(w => APPS.find(app => app.id === w.appId)?.plugin)
    if (open.length && !await dialog.confirm({ title: 'Reload extensions?',
      message: `This closes ${open.length} open extension ${open.length === 1 ? 'window' : 'windows'}. Save any work in those apps first.`, okLabel: 'Reload' })) return
    setPending(n => n + 1); setError(''); setNote('')
    try {
      const loaded = await reloadPlugins(ids => state.wins.filter(w => ids.includes(w.appId)).forEach(w => dispatch({ t: 'close', id: w.id })))
      setNote(`${loaded.length} extensions loaded`)
    } catch (e) { setError(String(e)) } finally { setPending(n => n - 1) }
  }
  const choosePicture = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const file = await open({ title: 'Choose a wallpaper', multiple: false, directory: false,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'heic'] }] })
      if (typeof file === 'string') await save('desk.wallpaper', deskTokens.wallpaper, file)
    } catch (e) { setError(String(e)) }
  }
  const tokenRow = (id: string, decl: TokenDecl, label?: string) => <TokenSetting key={id} id={id} decl={decl}
    host={host} save={save} disabled={busy} label={label} />
  const q = query.trim().toLocaleLowerCase()
  const searchResults = (() => {
    if (!q) return []
    const results = PAGES.filter(page => `${page.title} ${page.description}`.toLocaleLowerCase().includes(q))
      .map(page => ({ title: page.title, detail: 'Settings', section: page.id, icon: page.icon, token: '' }))
    for (const app of APPS) {
      if (`${app.title} ${app.id} ${app.description ?? ''}`.toLocaleLowerCase().includes(q))
        results.push({ title: app.title, detail: app.plugin ? 'Extension' : 'Built-in app', section: `app:${app.id}`, icon: app.icon, token: '' })
    }
    for (const [appId, tokens] of declarations()) {
      if (appId !== 'desk' && !APPS.some(app => app.id === appId)) continue
      for (const [name, decl] of Object.entries(tokens)) {
        if (!`${decl.label} ${decl.hint ?? ''}`.toLocaleLowerCase().includes(q)) continue
        const wallpaper = ['wallpaper', 'tint'].includes(name)
        results.push({ title: decl.label, detail: appId === 'desk' ? wallpaper ? 'Wallpaper' : 'Appearance' : APPS.find(a => a.id === appId)?.title || appId,
          section: appId === 'desk' ? wallpaper ? 'wallpaper' : 'appearance' : `app:${appId}`, icon: 'lucide:sliders-horizontal', token: `${appId}.${name}` })
      }
    }
    return results
  })()

  return <div className="settings-app">
    <aside className="settings-sidebar">
      <div className="settings-machine"><span className="settings-machine-avatar"><Icon id="lucide:laptop" size={25} /></span>
        <div><strong>{machineName}</strong><span>{host}</span></div></div>
      <label className="settings-search"><Icon id="lucide:search" size={14} />
        <input ref={searchInput} aria-label="Search settings" placeholder="Search settings" value={query}
          onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQuery('') }} />
        {query && <button aria-label="Clear settings search" onClick={() => setQuery('')}><Icon id="lucide:x" size={12} /></button>}
      </label>
      <nav aria-label="Settings categories">
        <span className="settings-nav-label">Personalization</span>
        {PAGES.map((item, i) => <div key={item.id}>
          {i === 2 && <span className="settings-nav-label">Workspace</span>}
          {i === 5 && <span className="settings-nav-label">More</span>}
          <button aria-current={!q && (section === item.id || (activeApp && item.id === 'apps')) ? 'page' : undefined}
            onClick={() => navigate(item.id)}>
            <span className={`settings-nav-icon settings-nav-icon-${item.id}`}><Icon id={item.icon} size={16} /></span>{item.title}
          </button>
        </div>)}
      </nav>
      <div className="settings-sidebar-bottom"><span className="status-dot" /><span>Personal settings<br /><small>{['keyboard', 'developer'].includes(section) ? 'On this Mac · All machines' : 'For this machine'}</small></span></div>
    </aside>

    <main className="settings-main">
      <header className="settings-page-header">
        {activeApp && !q && <button className="settings-back" onClick={() => navigate('apps')} aria-label="Back to Apps & Extensions"><Icon id="lucide:chevron-left" size={18} /></button>}
        <div><h1>{q ? 'Search results' : activeApp?.title || page.title}</h1>
          <p>{q ? `Settings matching “${query.trim()}”` : activeApp ? 'Preferences for this app on ' + machineName + '.' : page.description}</p></div>
      </header>
      <div ref={content} className="settings-content">
        {q ? <div className="settings-group-body settings-search-results">
          {searchResults.map((result, index) => <button key={index} onClick={() => navigate(result.section, result.token)}>
            <Icon id={result.icon} size={18} /><span><strong>{result.title}</strong><small>{result.detail}</small></span><Icon id="lucide:chevron-right" size={14} />
          </button>)}
          {!searchResults.length && <div className="settings-empty"><Icon id="lucide:search" size={28} /><strong>No settings found</strong><p>Try an app name, “wallpaper”, or “color”.</p></div>}
        </div> : section === 'appearance' ? <>
          <DesktopPreview host={host} wallpaper={pictureUrl} />
          <SettingsGroup title="Personalize your desktop">
            <SettingsRow id="desk.accent" label="Accent color" description="Selections and controls throughout your workspace.">
              <div className="settings-accent-options">{ACCENTS.map(([name, color]) => <button key={name} title={name} aria-label={`${name} accent`}
                aria-pressed={read('accent').toLowerCase() === color} disabled={busy} style={{ '--swatch': color } as CSSProperties}
                onClick={() => void save('desk.accent', deskTokens.accent, color)}><span />{read('accent').toLowerCase() === color && <Icon id="lucide:check" size={11} />}</button>)}</div>
            </SettingsRow>
            {deskTokens.accent && tokenRow('desk.accent', deskTokens.accent, 'Custom accent color')}
            <SettingsRow id="desk.radius" label="Window corners">
              <div className="settings-segmented" aria-label="Window corners">{[['Square', '0px'], ['Rounded', '12px'], ['Soft', '18px']].map(([label, value]) =>
                <button key={value} disabled={busy} aria-pressed={read('radius') === value} onClick={() => void save('desk.radius', deskTokens.radius, value)}>{label}</button>)}</div>
            </SettingsRow>
          </SettingsGroup>
          <button className="settings-link-row" onClick={() => navigate('wallpaper')}><Icon id="lucide:mountain" size={17} /><span>Change wallpaper</span><Icon id="lucide:chevron-right" size={14} /></button>
          <details className="settings-disclosure" open={customizing} onToggle={e => setCustomizing(e.currentTarget.open)}>
            <summary>Customize colors & surfaces<span>Fine-tune individual desktop elements</span></summary>
            {APPEARANCE_GROUPS.map(group => <SettingsGroup key={group.title} title={group.title}>
              {group.names.map(name => deskTokens[name] && tokenRow(`desk.${name}`, deskTokens[name]))}
            </SettingsGroup>)}
            <SettingsGroup title="Custom window corners">{deskTokens.radius && tokenRow('desk.radius', deskTokens.radius)}</SettingsGroup>
          </details>
        </> : section === 'wallpaper' ? <>
          <DesktopPreview host={host} wallpaper={pictureUrl} large />
          <SettingsGroup title="Desktop picture">
            <SettingsRow id="desk.wallpaper" label={picture ? picture.split('/').pop() || 'Custom picture' : 'Default desktop'}
              description="Choose an image from this Mac."><button className="settings-button" disabled={busy} onClick={() => void choosePicture()}>Choose picture…</button></SettingsRow>
            {picture && <SettingsRow label="Use the default background"><button className="settings-button" disabled={busy}
              onClick={() => void save('desk.wallpaper', deskTokens.wallpaper)}>Remove picture</button></SettingsRow>}
            {deskTokens.tint && tokenRow('desk.tint', deskTokens.tint, 'Picture tint')}
          </SettingsGroup>
          <p className="settings-footnote">The picture fills this machine’s desktop. Other machines keep their own wallpaper.</p>
          {picture && !pictureUrl && <p className="settings-footnote">The preview is loading, or the picture is no longer available on this Mac.</p>}
        </> : section === 'developer' ? <DeveloperSettings /> : section === 'keyboard' ? <KeyboardSettings /> : section === 'apps' ? <>
          <div className="settings-app-toolbar"><div className="settings-segmented" aria-label="App type">
            {(['all', 'builtin', 'extensions'] as const).map(value => <button key={value} aria-pressed={filter === value}
              onClick={() => setFilter(value)}>{value === 'all' ? 'All apps' : value === 'builtin' ? 'Built-in' : 'Extensions'}</button>)}
          </div><button className="settings-button" disabled={busy} onClick={() => void reload()}><Icon id="lucide:rotate-cw" size={13} />Reload extensions</button></div>
          {(['builtin', 'extensions'] as const).filter(kind => filter === 'all' || filter === kind).map(kind => {
            const list = apps.filter(app => kind === 'extensions' ? !!app.plugin : !app.plugin)
            return <SettingsGroup key={kind} title={kind === 'extensions' ? `Extensions · ${list.length}` : `Built-in apps · ${list.length}`}>
              {list.map(app => <button key={app.id} className="settings-app-row" onClick={() => navigate(`app:${app.id}`)}>
                <AppIcon app={app} host={host} /><span><strong>{app.title}</strong><small>{app.description || BUILTIN_DESCRIPTIONS[app.id] || 'JavaScript extension'}</small></span>
                <Icon id="lucide:chevron-right" size={14} /></button>)}
              {!list.length && <p className="settings-empty">No extensions are loaded.</p>}
            </SettingsGroup>
          })}
          {pluginFailures().length > 0 && <SettingsGroup title="Couldn’t load">
            {pluginFailures().map(failure => <div className="settings-extension-error" key={failure.directory}>
              <strong>{failure.name}</strong><p>{failure.message}</p><code>{failure.directory}</code>
            </div>)}
          </SettingsGroup>}
          <button className="settings-link-row" onClick={() => navigate('developer')}><Icon id="lucide:puzzle" size={17} /><span>Develop a local app</span><Icon id="lucide:chevron-right" size={14} /></button>
          <p className="settings-footnote">Extension apps join the desktop and provide their own settings here.</p>
        </> : activeApp ? <>
          <div className="settings-app-heading"><AppIcon app={activeApp} host={host} large /><div><h2>{activeApp.title}</h2>
            <span className="settings-app-kind">{activeApp.plugin ? 'JavaScript extension' : 'Built-in app'}</span>
            <p>{activeApp.description || BUILTIN_DESCRIPTIONS[activeApp.id] || 'An app for your sshdesk workspace.'}</p></div>
            {!activeApp.hidden && <button className="settings-button" onClick={() => fw.ui.open(activeApp.id, { host })}>Open app<Icon id="lucide:arrow-up-right" size={13} /></button>}</div>
          <SettingsGroup title="Appearance">
            {Object.entries(appTokens).map(([name, decl]) => tokenRow(`${activeApp.id}.${name}`, decl))}
            {!Object.keys(appTokens).length && <p className="settings-empty">This app has no appearance settings.</p>}
          </SettingsGroup>
          {Object.keys(appTokens).length <= 1 && <p className="settings-footnote">Additional preferences, when available, are managed inside the app.</p>}
          {!!activeApp.requires?.length && <SettingsGroup title="Required on this machine">
            {activeApp.requires.map(requirement => <SettingsRow key={requirement.command} label={requirement.command}
              description={requirement.kind === 'archive' ? 'Supporting tool' : requirement.kind === 'package' ? 'System package' : 'Command-line tool'}>
              <span className="settings-secondary">Checked when you open the app</span>
            </SettingsRow>)}
          </SettingsGroup>}
          <details className="settings-technical"><summary>App details</summary><dl>
            <dt>App ID</dt><dd>{activeApp.id}</dd>
            {activeApp.plugin?.version && <><dt>Version</dt><dd>{activeApp.plugin.version}</dd></>}
            {activeApp.plugin?.author && <><dt>Author</dt><dd>{activeApp.plugin.author}</dd></>}
            {activeApp.plugin && <><dt>Source folder on this Mac</dt><dd>{activeApp.plugin.directory}</dd></>}
          </dl></details>
        </> : section === 'tools' ? <>
          <div className="settings-tools-summary"><span className="settings-summary-icon"><Icon id="lucide:hard-drive" size={27} /></span>
            <div><strong>{tools ? `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}` : 'Remote tools'}</strong>
              <span>{tools ? `${fw.fmt.size(tools.reduce((sum, tool) => sum + tool.size, 0))} on ${machineName}` : machineName}</span></div>
            <button className="settings-button" disabled={busy} onClick={() => void loadTools()}><Icon id="lucide:rotate-cw" size={13} />Refresh</button></div>
          {toolsError ? <div className="settings-inline-error" role="alert">{toolsError}</div> : tools === null ? <div className="settings-loading" role="status"><span className="ui-spinner" />Reading installed tools…</div>
            : tools.length === 0 ? <div className="settings-empty"><Icon id="lucide:package" size={32} /><strong>No supporting tools installed</strong><p>Apps that need extra software will guide you through setup.</p></div>
            : <SettingsGroup title="Installed by sshdesk">{tools.map(tool => <SettingsRow key={tool.name} label={tool.name} description={fw.fmt.size(tool.size)}>
              <button className="settings-button" disabled={busy} onClick={async () => {
                if (!await dialog.confirm({ title: `Remove ${tool.name}?`, message: `This permanently removes ~/.sshdesk/opt/${tool.name} and all its contents from ${machineName}, including any app data in that folder. Apps that use it may need setup again.`, okLabel: 'Remove', danger: true })) return
                setPending(n => n + 1); setError(''); setNote('')
                try { await fw.deps.remove(tool.name); await loadTools(); setNote(`${tool.name} removed`) }
                catch (e) { setError(String(e)) } finally { setPending(n => n - 1) }
              }}>Remove…</button>
            </SettingsRow>)}</SettingsGroup>}
          <button className="settings-link-row" onClick={() => fw.ui.open('packages', { host })}><Icon id="lucide:package" size={17} /><span>Manage system packages</span><Icon id="lucide:arrow-up-right" size={14} /></button>
          <p className="settings-footnote">Supporting tools live in <code>~/.sshdesk/opt</code> on this machine. Desktop extensions live on your Mac.</p>
        </> : section === 'advanced' ? <>
          <SettingsGroup title="Configuration">
            <SettingsRow label="Applies to" description={host}><span className="settings-secondary">{machineName}</span></SettingsRow>
            <SettingsRow label="Saved customizations"><span className="settings-secondary">{Object.keys(machineConfig(host)).length}</span></SettingsRow>
            <div className="settings-path-row"><span>Settings file on this Mac</span><code>{configPath || 'Path unavailable'}</code></div>
            <SettingsRow label="Reload settings" description="Read changes made outside this window."><button className="settings-button" disabled={busy} onClick={async () => {
              setPending(n => n + 1); setError(''); setNote('')
              try { const cfg = await fw.config.load(); setConfig(cfg.values, cfg.machines); setNote('Settings reloaded'); if (cfg.warnings.length) setError(cfg.warnings.join('\n')) }
              catch (e) { setError(String(e)) } finally { setPending(n => n - 1) }
            }}>Reload</button></SettingsRow>
          </SettingsGroup>
          <SettingsGroup title="JavaScript extensions"><SettingsRow label="Build your own app" description="Apps register their icons and appearance settings automatically.">
            <button className="settings-button" onClick={() => setInstallHelp(true)}>Getting started</button></SettingsRow></SettingsGroup>
          <p className="settings-footnote">Settings are saved on this Mac, separately for each machine. Reset buttons restore the defaults supplied by the desktop or app.</p>
        </> : <div className="settings-empty"><strong>This app is no longer loaded</strong><button className="settings-button" onClick={() => navigate('apps')}>Back to apps</button></div>}
      </div>
      <footer className={`settings-status ${error ? 'has-error' : ''}`} role="status">
        {busy ? <><span className="ui-spinner" /><span>Applying changes…</span></> : error ? <><Icon id="lucide:circle-alert" size={14} /><span className="select-text">{error}</span></>
          : <><Icon id="lucide:check" size={13} /><span>{note || 'Changes save automatically'}</span></>}
        <span className="settings-status-machine">{['keyboard', 'developer'].includes(section) ? 'This Mac' : machineName}</span>
      </footer>
    </main>
    {installHelp && <SettingsModal title="Add a JavaScript extension" onClose={() => setInstallHelp(false)} wide>
      <div className="settings-modal-body settings-extension-guide">
        <p>Extensions add apps to your desktop. Each app lives in its own folder on this Mac.</p>
        <ol><li><strong>Add the app folder</strong><span>Place its files in:</span><code>~/.sshdesk/plugins/my-app/</code></li>
          <li><strong>Include an entry file</strong><span>The folder needs an <code>index.js</code> file that exports a manifest and <code>createApp</code>. Include <code>style.css</code> for app styles.</span></li>
          <li><strong>Reload extensions</strong><span>Return to Apps & Extensions and choose Reload extensions. The app appears in your dock and in Settings.</span></li></ol>
        <details className="settings-technical"><summary>For app developers</summary>
          <p>Optional manifest fields <code>description</code>, <code>version</code>, and <code>author</code> appear in app details. Declare icon, color, image, and length preferences in <code>manifest.tokens</code>; Settings builds the controls for you.</p>
        </details>
        <p className="settings-footnote">Only add extensions you trust. They run inside sshdesk and can access your connected machines.</p>
      </div><footer><button className="settings-button is-primary" onClick={() => setInstallHelp(false)}>Done</button></footer>
    </SettingsModal>}
  </div>
}

function AppIcon({ app, host, large = false }: { app: AppDef; host: string; large?: boolean }) {
  return <span className={`settings-app-icon app-tile app-tile-${app.id} ${large ? 'is-large' : ''}`}><Icon token={`${app.id}.app`} host={host} fallback={app.icon} size={large ? 29 : 21} /></span>
}

function DesktopPreview({ host, wallpaper, large = false }: { host: string; wallpaper: string; large?: boolean }) {
  const value = (name: string) => resolve(`desk.${name}`, host).value
  return <div className={`settings-desktop-preview ${large ? 'is-large' : ''}`} aria-label="Desktop preview"
    style={{ backgroundColor: value('bg'), backgroundImage: wallpaper ? `url(${wallpaper})` : undefined }}>
    <div className="settings-preview-tint" style={{ background: value('tint') }} />
    <div className="settings-preview-menubar" style={{ background: value('menubar'), color: value('fg') }}><strong>sshdesk</strong><span>Desktop preview</span></div>
    <div className="settings-preview-window" style={{ background: value('panel'), borderColor: value('border'), borderRadius: value('radius') }}>
      <div className="settings-preview-title" style={{ background: value('titlebar'), borderColor: value('line') }}><i /><i /><i /><span style={{ color: value('fg') }}>Files</span></div>
      <div className="settings-preview-body"><div style={{ borderColor: value('line') }}><span style={{ background: value('selection'), color: value('fg') }}>Home</span><span style={{ color: value('dim') }}>Documents</span></div>
        <div>{['Documents', 'Downloads', 'Pictures'].map(name => <span key={name} style={{ color: value('fg') }}><Icon id="desk:folder" size={13} className="settings-preview-folder" /><span>{name}</span></span>)}</div></div>
    </div>
    <div className="settings-preview-dock" style={{ background: value('dock') }}>{['files', 'terminal', 'settings'].map(id => <span key={id} className={`app-tile app-tile-${id}`}><Icon token={`${id}.app`} host={host} size={14} /></span>)}</div>
  </div>
}
