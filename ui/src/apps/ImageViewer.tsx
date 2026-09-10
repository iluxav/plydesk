import { useCallback, useEffect, useRef, useState } from 'react'
import { useFw } from '../wm/host'
import { Icon } from '../wm/Icon'
import { mimeOf } from '../fw/mime'

/**
 * Image preview.
 *
 * Bytes come over SFTP and become a data URL. That is the whole trick: the
 * webview cannot reach the remote, and a local HTTP shim to serve one image
 * would be a server, a port and a lifetime to manage for something a base64
 * string does in one round trip.
 *
 * SVG is rendered through <img>, where scripts do not run — worth being
 * deliberate about, since these bytes come from a machine you may not control.
 */
export function ImageViewer({ path, setTitle }: {
  path?: string
  setTitle?: (t: string) => void
}) {
  const fw = useFw()
  const [src, setSrc] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [size, setSize] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)

  /** null means fit-to-window; a number is an explicit scale. */
  const [zoom, setZoom] = useState<number | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [viewport, setViewport] = useState({ w: 0, h: 0 })
  const [panning, setPanning] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const name = path ? fw.path.base(path) : ''

  useEffect(() => { setTitle?.(name || 'Preview') }, [name, setTitle])

  const load = useCallback(async () => {
    if (!path) return
    setBusy(true); setErr(''); setSrc(''); setDims(null)
    setZoom(null); setPan({ x: 0, y: 0 })
    try {
      const r = await fw.fs.readBinary(path)
      setSize(r.size)
      setTruncated(r.truncated)
      setSrc(`data:${r.mime || mimeOf(path)};base64,${r.b64}`)
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }, [fw, path])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const el = box.current
    if (!el) return
    const resize = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }))
    resize.observe(el)
    return () => resize.disconnect()
  }, [])

  // Fit is computed rather than left to CSS so the status bar can report a
  // percentage, and so toggling to 1:1 has something to toggle back to.
  const fitScale = () => {
    if (!dims || !viewport.w || !viewport.h) return 1
    return Math.max(0.01, Math.min(1, (viewport.w - 32) / dims.w, (viewport.h - 32) / dims.h))
  }
  const scale = zoom ?? fitScale()

  const nudgeZoom = (factor: number) => {
    setZoom(z => Math.min(16, Math.max(0.05, (z ?? fitScale()) * factor)))
  }

  const drag = useRef<{ x: number; y: number } | null>(null)

  return (
    <div className="desk-app preview-app">
      <div className="app-toolbar" role="toolbar" aria-label="Image tools">
        <button onClick={() => nudgeZoom(1 / 1.25)} title="Zoom out"
          aria-label="Zoom out" disabled={!dims || scale <= 0.05} className="app-button is-icon">−</button>
        <div className="app-segmented" aria-label="Image size">
        <button onClick={() => { setZoom(null); setPan({ x: 0, y: 0 }) }} title="Fit to window"
          disabled={!dims} aria-pressed={zoom === null}>Fit</button>
        <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} title="Actual size"
          disabled={!dims} aria-pressed={zoom === 1}>Actual size</button>
        </div>
        <button onClick={() => nudgeZoom(1.25)} title="Zoom in"
          aria-label="Zoom in" disabled={!dims || scale >= 16} className="app-button is-icon">+</button>
        <span className="app-toolbar-spacer" />
        <span className="app-toolbar-label">{name}</span>
        <button onClick={load} title="Reload image" aria-label="Reload image" disabled={!path || busy}
          className="app-button is-icon"><Icon id="desk:refresh" size={13} /></button>
      </div>

      <div
        ref={box}
        onWheel={e => {
          if (!e.metaKey && !e.ctrlKey) return
          e.preventDefault()
          nudgeZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1)
        }}
        onPointerDown={e => {
          if (scale <= fitScale()) return           // nothing to pan
          e.preventDefault(); setPanning(true)
          drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={e => {
          if (!drag.current) return
          setPan({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y })
        }}
        onPointerUp={() => { drag.current = null; setPanning(false) }}
        onPointerCancel={() => { drag.current = null; setPanning(false) }}
        onLostPointerCapture={() => { drag.current = null; setPanning(false) }}
        onDoubleClick={() => { setZoom(z => (z === 1 ? null : 1)); setPan({ x: 0, y: 0 }) }}
        className="preview-canvas"
        style={{ cursor: panning ? 'grabbing' : scale > fitScale() ? 'grab' : 'default' }}
      >
        {busy && <div className="app-empty-state" role="status"><span className="ui-spinner" /><p>Loading image…</p></div>}
        {err && <div className="app-empty-state" role="alert"><Icon id="lucide:circle-alert" size={28} /><h2>Unable to show this image</h2><p className="select-text">{err}</p><button className="app-button" onClick={load}>Try again</button></div>}
        {!busy && !err && !path && <div className="app-empty-state"><span className="app-empty-mark"><Icon id="lucide:mountain" size={28} /></span><h2>Open an image in Files</h2><p>Preview pictures from your connected machine.</p><button className="app-button" onClick={() => fw.ui.open('files', { host: fw.host.current() })}>Browse files</button></div>}
        {src && !err && (
          <img
            src={src}
            alt={name}
            draggable={false}
            onLoad={e => setDims({
              w: (e.target as HTMLImageElement).naturalWidth,
              h: (e.target as HTMLImageElement).naturalHeight,
            })}
            onError={() => setErr('could not decode this image')}
            style={{
              width: dims ? dims.w * scale : undefined,
              height: dims ? dims.h * scale : undefined,
              transform: `translate(${pan.x}px, ${pan.y}px)`,
              imageRendering: scale >= 2 ? 'pixelated' : 'auto',
              maxWidth: 'none', maxHeight: 'none',
            }} />
        )}
      </div>

      <div className="app-statusbar" role="status">
        {dims && <span>{dims.w} × {dims.h}</span>}
        {size > 0 && <span>· {fw.fmt.size(size)}</span>}
        {dims && <span>· {Math.round(scale * 100)}%</span>}
        {truncated && <span className="text-desk-bad">· truncated — file is larger than the read cap</span>}
        <span className="app-status-end app-status-optional">⌘ Scroll to zoom · Double-click for actual size</span>
      </div>
    </div>
  )
}
