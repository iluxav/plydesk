import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../wm/Icon'
import { useModalFocus } from '../../wm/useModalFocus'
import { configKey, declOf, machineConfig, resolve, type TokenDecl } from '../../fw/tokens'
import { iconCount, searchIcons } from '../../fw/icons'

export type SaveSetting = (id: string, decl: TokenDecl, value?: string) => Promise<boolean>

export function SettingsModal({ title, children, onClose, wide = false }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useModalFocus(ref, true)
  return createPortal(<div className="settings-modal-overlay" onPointerDown={onClose}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
      className={`settings-modal ${wide ? 'is-wide' : ''}`} onPointerDown={e => e.stopPropagation()}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }}>
      <header><h2 id={titleId}>{title}</h2><button className="settings-icon-button" aria-label="Close dialog" onClick={onClose}>
        <Icon id="lucide:x" size={16} /></button></header>
      {children}
    </div>
  </div>, document.body)
}

export function SettingsGroup({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
  return <section className="settings-group" aria-label={title}>
    {title && <h3>{title}</h3>}
    {description && <p className="settings-group-description">{description}</p>}
    <div className="settings-group-body">{children}</div>
  </section>
}

export function SettingsRow({ label, description, children, id }: {
  label: string; description?: string; children: ReactNode; id?: string
}) {
  return <div className="settings-row" data-setting={id}>
    <div className="settings-row-label"><span>{label}</span>{description && <small>{description}</small>}</div>
    <div className="settings-row-control">{children}</div>
  </div>
}

function splitColor(value: string): { rgb: string; alpha: number } | null {
  if (!/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return null
  let hex = value.slice(1)
  if (hex.length < 5) hex = [...hex].map(c => c + c).join('')
  return { rgb: `#${hex.slice(0, 6)}`, alpha: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1 }
}

function joinColor(rgb: string, alpha: number) {
  return rgb + (alpha >= 1 ? '' : Math.round(alpha * 255).toString(16).padStart(2, '0'))
}

export function TokenSetting({ id, decl, host, save, disabled, label, description }: {
  id: string; decl: TokenDecl; host: string; save: SaveSetting; disabled: boolean; label?: string; description?: string
}) {
  const [editing, setEditing] = useState(false)
  const resolved = resolve(id, host)
  const override = machineConfig(host)[configKey(id, decl.type)]
  const title = label || decl.label
  return <>
    <SettingsRow id={id} label={title} description={description || decl.hint}>
      <button className={`settings-value-button ${decl.type === 'color' ? 'is-color' : ''}`} disabled={disabled}
        aria-label={`Change ${title}`} onClick={() => setEditing(true)}>
        {decl.type === 'icon' ? <><Icon id={resolved.value} size={21} /><span>Change…</span></>
          : decl.type === 'color' ? <><span className="settings-color-well"><span style={{ background: resolved.value }} /></span>
            <span>{override === undefined ? 'Default' : 'Custom'}</span></>
          : <span>{(decl.type === 'image' ? resolved.value.split('/').pop() : resolved.value) || 'Choose…'}</span>}
      </button>
      <button className="settings-icon-button settings-reset" disabled={disabled || override === undefined}
        aria-label={`Reset ${title}`} title={`Restore default ${title.toLowerCase()}`}
        onClick={() => void save(id, decl)}><Icon id="lucide:rotate-ccw" size={13} /></button>
    </SettingsRow>
    {editing && (decl.type === 'icon'
      ? <IconPicker title={title} current={resolved.value} onClose={() => setEditing(false)}
          onPick={async value => { if (await save(id, decl, value)) setEditing(false) }} disabled={disabled} />
      : <ValueEditor key={id} title={title} id={id} decl={decl} initial={override ?? resolved.value}
          resolved={resolved.value} disabled={disabled} onClose={() => setEditing(false)}
          onApply={async value => { if (await save(id, decl, value)) setEditing(false) }} />)}
  </>
}

function ValueEditor({ title, id, decl, initial, resolved, onClose, onApply, disabled }: {
  title: string; id: string; decl: TokenDecl; initial: string; resolved: string; disabled: boolean
  onClose: () => void; onApply: (value: string) => Promise<void>
}) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState('')
  const parsed = splitColor(value)
  const inherited = value.startsWith('@') ? declOf(value.slice(1)) : undefined
  const valid = value.startsWith('@') ? !!inherited && inherited.type === decl.type && value !== `@${id}`
    : decl.type === 'color' ? CSS.supports('color', value) : decl.type === 'image' ? !!value.trim() : CSS.supports('width', value)
  const validation = decl.type === 'color' ? 'Enter a valid color or a matching setting reference.'
    : decl.type === 'image' ? 'Choose an image file or enter its path.' : 'Enter a valid size, such as 12px.'
  const apply = async () => {
    if (!valid) { setError(validation); return }
    await onApply(value.trim())
  }
  return <SettingsModal title={title} onClose={onClose}>
    <div className="settings-modal-body">
      {decl.type === 'color' && <>
        <div className="settings-color-preview"><span style={{ background: valid && !value.startsWith('@') ? value : resolved }} /></div>
        <label className="settings-editor-field">Color
          <div className="settings-color-input-row"><input type="color" aria-label={`${title} color`}
            value={parsed?.rgb ?? splitColor(resolved)?.rgb ?? '#60a5fa'} disabled={disabled}
            onChange={e => setValue(joinColor(e.target.value, parsed?.alpha ?? 1))} />
            <input aria-label="Color value" aria-invalid={!valid} value={value} spellCheck={false} disabled={disabled}
              onChange={e => { setValue(e.target.value); setError('') }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void apply() } }} /></div>
        </label>
        <label className="settings-editor-field">Opacity <span>{Math.round((parsed?.alpha ?? 1) * 100)}%</span>
          <input type="range" min="0" max="100" aria-label={`${title} opacity`} value={Math.round((parsed?.alpha ?? 1) * 100)}
            disabled={disabled || !parsed} onChange={e => { if (parsed) setValue(joinColor(parsed.rgb, Number(e.target.value) / 100)) }} />
        </label>
      </>}
      {decl.type === 'length' && <label className="settings-editor-field">Size<input value={value} aria-invalid={!valid} disabled={disabled}
        onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void apply() } }} /></label>}
      {decl.type === 'image' && <>
        <label className="settings-editor-field">Image file on this Mac<input value={value} disabled={disabled}
          onChange={e => { setValue(e.target.value); setError('') }} /></label>
        <button className="settings-button settings-image-choose" disabled={disabled} onClick={async () => {
          try {
            const { open } = await import('@tauri-apps/plugin-dialog')
            const file = await open({ title: `Choose ${title.toLowerCase()}`, multiple: false,
              filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'heic'] }] })
            if (typeof file === 'string') { setValue(file); setError('') }
          } catch (e) { setError(String(e)) }
        }}>Choose image…</button>
      </>}
      <details className="settings-technical"><summary>Setting details</summary>
        <dl><dt>Configuration key</dt><dd>{configKey(id, decl.type)}</dd><dt>Default value</dt><dd>{decl.default}</dd></dl>
      </details>
      {(error || !valid) && <p className="settings-inline-error" role="alert">{error || validation}</p>}
    </div>
    <footer><button className="settings-button" onClick={onClose}>Cancel</button>
      <button className="settings-button is-primary" disabled={disabled || !valid} onClick={() => void apply()}>Apply</button></footer>
  </SettingsModal>
}

function IconPicker({ title, current, onPick, onClose, disabled }: {
  title: string; current: string; onPick: (value: string) => Promise<void>; onClose: () => void; disabled: boolean
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(current)
  const [glyph, setGlyph] = useState('')
  const results = useMemo(() => searchIcons(query, 180), [query])
  return <SettingsModal title={`Choose ${title.toLowerCase()}`} onClose={onClose} wide>
    <div className="settings-icon-search"><Icon id="lucide:search" size={15} />
      <input data-autofocus aria-label="Search icons" placeholder={`Search ${iconCount().toLocaleString()} icons`} value={query}
        onChange={e => setQuery(e.target.value)} />
    </div>
    <div className="settings-icon-results" aria-label="Available icons">
      {results.map(id => <button key={id} title={id} aria-label={id} aria-pressed={selected === id}
        onClick={() => setSelected(id)} disabled={disabled}><Icon id={id} size={23} /></button>)}
      {!results.length && <p className="settings-empty">No icons match “{query}”.</p>}
    </div>
    <div className="settings-icon-custom"><label>Or use an emoji<input aria-label="Custom emoji" placeholder="📁" value={glyph}
      onChange={e => { setGlyph(e.target.value); if (e.target.value.trim()) setSelected(e.target.value.trim()) }} /></label>
      <span className="settings-icon-selection"><Icon id={selected} size={20} /><span>{selected}</span></span>
    </div>
    <footer><button className="settings-button" onClick={onClose}>Cancel</button>
      <button className="settings-button is-primary" disabled={disabled || !selected} onClick={() => void onPick(selected)}>Use icon</button></footer>
  </SettingsModal>
}
