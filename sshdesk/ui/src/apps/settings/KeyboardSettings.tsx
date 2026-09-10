import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Icon } from '../../wm/Icon'
import { useKeyboard } from '../../keyboard/KeyboardProvider'
import { saveKeyboardPreferences, useKeyboardPreferences } from '../../keyboard/preferences'
import { ACTIONS, META, SHIFT, conflict, defaults, equalShortcut, formatShortcut, shortcutError, type ActionId, type KeyboardPreferences, type Shortcut } from '../../keyboard/shortcuts'
import { SettingsGroup, SettingsModal, SettingsRow } from './SettingControls'

export function KeyboardSettings() {
  const preferences = useKeyboardPreferences()
  const { status, error: nativeError, refresh } = useKeyboard()
  const [editing, setEditing] = useState<ActionId | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const close = useCallback(() => setEditing(null), [])
  const save = (next: KeyboardPreferences) => {
    try { saveKeyboardPreferences(next); setMessage('Shortcuts saved on this Mac.'); setError(''); return true }
    catch (e) { setError(`Couldn’t save shortcuts: ${String(e)}`); return false }
  }
  const assign = (id: ActionId, shortcut: Shortcut | null) => {
    const used = conflict(preferences.bindings, id, shortcut)
    if (used) { setError(`Already assigned to ${used.label.toLowerCase()}. Change that shortcut first.`); return false }
    return save({ ...preferences, bindings: { ...preferences.bindings, [id]: shortcut } })
  }
  const requestAccess = async () => {
    try { await invoke('keyboard_request_access'); setMessage('Enable sshdesk in macOS Accessibility, then return here.'); refresh() }
    catch (e) { setError(String(e)) }
  }
  const setCapture = (enabled: boolean) => {
    if (save({ ...preferences, captureSystem: enabled }) && enabled && !status.accessibility) void requestAccess()
  }
  const useCommandTab = () => {
    const bindings = { ...preferences.bindings, 'next-window': { code: 'Tab', modifiers: META },
      'previous-window': { code: 'Tab', modifiers: META | SHIFT } }
    for (const id of ['next-window', 'previous-window'] as const) {
      const used = conflict(bindings, id, bindings[id])
      if (used) { setError(`Command-Tab conflicts with ${used.label.toLowerCase()}. Change that shortcut first.`); return }
    }
    if (save({ bindings, captureSystem: true }) && !status.accessibility) void requestAccess()
  }
  return <>
    <div className="shortcut-overview"><Icon id="lucide:keyboard" size={30} /><div>
      <strong>Your desktop, from the keyboard</strong>
      <p>Arrange windows and move between apps without reaching for the mouse. Shortcuts apply to every connected machine on this Mac.</p>
    </div></div>
    {['Arrange windows', 'Switch windows'].map(group => <SettingsGroup key={group} title={group}
      description={group === 'Switch windows' ? 'Hold the modifier and press the switch key again to browse. Release to select; Escape cancels.' : 'Snapped windows stay above the dock. Restore returns to their previous size and position.'}>
      {ACTIONS.filter(action => action.group === group).map(action => <SettingsRow key={action.id} label={action.label}>
        <button className="settings-value-button shortcut-button" aria-label={`Change shortcut for ${action.label.toLowerCase()}`}
          onClick={() => { setEditing(action.id); setMessage(''); setError('') }}><kbd className="shortcut-key">{formatShortcut(preferences.bindings[action.id])}</kbd></button>
        <button className="settings-icon-button settings-reset" aria-label={`Reset ${action.label.toLowerCase()} shortcut`} title="Restore default shortcut"
          disabled={equalShortcut(preferences.bindings[action.id], action.shortcut)} onClick={() => assign(action.id, { ...action.shortcut })}><Icon id="lucide:rotate-ccw" size={13} /></button>
      </SettingsRow>)}
    </SettingsGroup>)}
    {status.native && <SettingsGroup title="macOS shortcuts" description="Allow assigned shortcuts such as Command-Tab to control sshdesk while its window is focused.">
      <SettingsRow label="Capture macOS shortcuts" description={preferences.captureSystem
        ? status.captureReady ? 'Active while sshdesk is focused.' : status.accessibility ? 'Capture is paused. Return to the desktop or retry.' : 'Accessibility permission is needed.'
        : 'Shortcuts reserved by macOS remain with macOS.'}>
        <input type="checkbox" role="switch" className="shortcut-toggle" aria-label="Capture macOS shortcuts" checked={preferences.captureSystem}
          onChange={e => setCapture(e.target.checked)} />
      </SettingsRow>
      <SettingsRow label="Use Command-Tab for window switching" description="Sets next window to ⌘Tab and previous window to ⇧⌘Tab.">
        <button className="settings-button" onClick={useCommandTab}>Use ⌘Tab</button>
      </SettingsRow>
      {preferences.captureSystem && !status.accessibility && <SettingsRow label="Allow access in macOS" description="Enable sshdesk under System Settings → Privacy & Security → Accessibility.">
        <button className="settings-button" onClick={() => void requestAccess()}>Open Accessibility…</button>
      </SettingsRow>}
      {preferences.captureSystem && status.accessibility && !status.captureReady && <SettingsRow label="Refresh shortcut capture"><button className="settings-button" onClick={refresh}>Retry</button></SettingsRow>}
    </SettingsGroup>}
    <p className="settings-footnote">Only assigned combinations are intercepted. Other keys keep working in your apps, including VS Code. Click outside sshdesk to return keyboard control to macOS. Command-Q and the macOS Force Quit shortcut stay available.</p>
    <div className="settings-app-toolbar"><button className="settings-button" onClick={() => save(defaults())}>Restore default shortcuts</button>
      <span className="settings-secondary" role="status">{message}</span></div>
    {(error || nativeError) && <p className="shortcut-error" role="alert">{error || nativeError}</p>}
    {editing && <ShortcutRecorder id={editing} onClose={close} onSave={shortcut => { if (assign(editing, shortcut)) close() }} />}
  </>
}

function ShortcutRecorder({ id, onClose, onSave }: { id: ActionId; onClose: () => void; onSave: (shortcut: Shortcut | null) => void }) {
  const { setRecorder, status } = useKeyboard()
  const preferences = useKeyboardPreferences()
  const [candidate, setCandidate] = useState<Shortcut | null>(null)
  const action = ACTIONS.find(a => a.id === id)!
  useEffect(() => {
    setRecorder(shortcut => { if (shortcut) setCandidate(shortcut); else onClose() })
    return () => setRecorder(null)
  }, [setRecorder, onClose])
  const used = conflict(preferences.bindings, id, candidate)
  const issue = candidate ? shortcutError(candidate) || (used ? `Already assigned to “${used.label}”. Choose another combination.` : '')
    || (candidate.code === 'Tab' && (candidate.modifiers & META) && !status.captureReady ? 'Enable macOS shortcut capture before assigning Command-Tab.' : '') : ''
  return <SettingsModal title={action.label} onClose={onClose}>
    <div className="shortcut-recorder" data-shortcut-recorder>
      <p>Press a combination with Command, Option, or Control. Your shortcut takes effect after you save it.</p>
      <div className="shortcut-recording" aria-live="polite">{candidate ? <kbd className="shortcut-key">{formatShortcut(candidate)}</kbd> : <span>Press your shortcut…</span>}</div>
      {issue && <div className="shortcut-error" role="alert">{issue}</div>}
      <div className="shortcut-actions"><button className="settings-button" onClick={() => onSave(null)}>Remove shortcut</button>
        <button className="settings-button" onClick={onClose}>Cancel</button>
        <button className="settings-button is-primary" disabled={!candidate || !!issue} onClick={() => onSave(candidate)}>Save shortcut</button>
      </div>
    </div>
  </SettingsModal>
}
