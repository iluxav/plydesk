import { useCallback, useEffect, useRef, useState } from 'react'
import { useFw } from '../wm/host'
import { Icon } from '../wm/Icon'
import { monaco, languageFor } from './monaco-setup'

export function Editor({ path, setTitle }: { path?: string; setTitle?: (t: string) => void }) {
  const fw = useFw()
  const host = useRef<HTMLDivElement>(null)
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const model = useRef<monaco.editor.ITextModel | null>(null)

  const [status, setStatus] = useState('loading…')
  const [dirty, setDirty] = useState(false)
  const [err, setErr] = useState('')
  const [lang, setLang] = useState('plaintext')
  const [wrap, setWrap] = useState(false)
  const [position, setPosition] = useState({ line: 1, column: 1 })
  const [meta, setMeta] = useState<{ size: number; truncated: boolean } | null>(null)

  const name = path ? fw.path.base(path) : 'untitled'
  const titleRef = useRef(setTitle)
  useEffect(() => { titleRef.current = setTitle })

  const save = useCallback(async () => {
    if (!path || !model.current || ed.current?.getOption(monaco.editor.EditorOption.readOnly)) return
    setErr(''); setStatus('saving…')
    try {
      await fw.fs.write(path, model.current.getValue())
      setDirty(false)
      setStatus('saved')
      fw.bus.emit('fs:changed', { dirs: [fw.path.parent(path)] })
    } catch (e) {
      setStatus('')
      setErr(String(e))          // permission is the machine's call; just show it
    }
  }, [fw, path])

  // create the editor once
  useEffect(() => {
    if (!host.current || !path) return
    const editor = monaco.editor.create(host.current, {
      theme: 'plydesk',
      automaticLayout: true,
      fontSize: 13,
      padding: { top: 12, bottom: 12 },
      lineHeight: 21,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      tabSize: 2,
      readOnly: !path,
    })
    ed.current = editor
    editor.onDidChangeCursorPosition(e => setPosition({ line: e.position.lineNumber, column: e.position.column }))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void saveRef.current() })
    return () => { editor.dispose(); model.current?.dispose() }
  }, [path])

  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save })

  // load the file
  useEffect(() => {
    if (!path) { setStatus('no file'); return }
    let cancelled = false
    setStatus('loading…'); setErr('')
    fw.fs.read(path)
      .then(r => {
        if (cancelled) return
        if (r.binary) {
          setStatus('')
          setErr(`${name} looks binary (${fw.fmt.size(r.size)}) — not opening it as text`)
          return
        }
        const language = languageFor(name)
        setLang(language)
        setMeta({ size: r.size, truncated: r.truncated })
        const m = monaco.editor.createModel(r.text, language,
          monaco.Uri.parse(`plydesk://${fw.host.current()}${path}`))
        model.current?.dispose()
        model.current = m
        ed.current?.setModel(m)
        m.onDidChangeContent(() => { setDirty(true); setStatus('') })
        setDirty(false)
        setStatus(r.truncated ? 'truncated at 2 MB — saving would lose the rest' : '')
        ed.current?.updateOptions({ readOnly: r.truncated })
        titleRef.current?.(`${name} — ${path}`)
      })
      .catch(e => { if (!cancelled) { setStatus(''); setErr(String(e)) } })
    return () => { cancelled = true }
  }, [fw, path, name])


  return (
    <div className="desk-app editor-app">
      <div className="app-toolbar" role="toolbar" aria-label="Editor tools">
        <button className="app-button" onClick={() => void save()} disabled={!dirty || !path || meta?.truncated}
          title="Save (⌘S)"><Icon id="desk:upload" size={14} />Save</button>
        <div className="editor-file" title={path}>{dirty && <i className="editor-dirty" aria-label="Unsaved changes" />}
          <span>{path ? name : 'No document open'}</span></div>
        <button className="app-button" disabled={!path || status === 'loading…' || !!err} aria-label="Find in document"
          onClick={() => ed.current?.getAction('actions.find')?.run()}><Icon id="desk:search" size={13} />Find</button>
        <button className="app-button" aria-pressed={wrap} disabled={!path}
          onClick={() => { setWrap(!wrap); ed.current?.updateOptions({ wordWrap: wrap ? 'off' : 'on' }) }}>Wrap lines</button>
      </div>
      {err && <div className="app-notice is-error" role="alert">{err}</div>}
      {meta?.truncated && <div className="app-notice is-warning">This file exceeds the read limit. The available text is open read-only.</div>}
      <div className="editor-content"><div ref={host} className="editor-surface" />
        {!path && <div className="app-empty-state"><span className="app-empty-mark"><Icon id="desk:editor" size={28} /></span>
          <h2>Open a file to start editing</h2><p>Browse this machine in Files, then open a text file or source document.</p>
          <button className="app-button" onClick={() => fw.ui.open('files', { host: fw.host.current() })}><Icon id="desk:folder" size={14} />Browse files</button>
        </div>}
      </div>
      <footer className="app-statusbar" role="status">
        <span>{path ? dirty ? 'Unsaved changes' : status || 'Saved on machine' : 'Editor'}</span>
        {path && <><span className="app-status-optional">Ln {position.line}, Col {position.column}</span>
          <span className="app-toolbar-spacer" /><select className="editor-language" aria-label="Document language" value={lang}
            onChange={e => { setLang(e.target.value); if (model.current) monaco.editor.setModelLanguage(model.current, e.target.value) }}>
            {monaco.languages.getLanguages().map(l => l.id).sort().map(id => <option key={id} value={id}>{id}</option>)}
          </select>{meta && <span>{fw.fmt.size(meta.size)}</span>}</>}
      </footer>
    </div>
  )
}
