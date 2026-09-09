import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../wm/Icon'
import { handlerFor } from '../desktop/registry'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type DirListing, type Entry } from '../fw'
import { useFw } from '../wm/host'
import { useContextMenu, type MenuItem } from '../wm/ContextMenu'
import { FileSidebar, DEFAULT_SHORTCUTS, type Shortcut } from './FileSidebar'
import { useDrag, useDropTarget, dropProps } from '../wm/dnd'
import { useDialog } from '../wm/Dialog'

let instances = 0

const ROW = 33

export function FileExplorer({ setTitle, path = '~' }: { setTitle?: (t: string) => void; path?: string }) {
  const [cwd, setCwd] = useState('~')
  const [d, setD] = useState<DirListing | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [home, setHome] = useState('')
  const history = useRef<{ paths: string[]; index: number }>({ paths: [], index: -1 })
  const request = useRef(0)
  const searchInput = useRef<HTMLInputElement>(null)
  /** True while an OS drag from Finder is hovering *this* explorer. */
  const [osDrop, setOsDrop] = useState(false)
  /** This explorer's outermost element, used to claim OS drops by hit test. */
  const root = useRef<HTMLDivElement>(null)

  // Pinned to this window's machine, not whichever host is focused.
  const fw = useFw()
  const menu = useContextMenu()
  const selfId = useRef(++instances).current
  const dropId = `files:${selfId}`
  const { drag, start: startDrag } = useDrag()
  const dlg = useDialog()
  // Per machine: these are paths, and a path on one box is not a path on
  // another. The third argument migrates whatever was pinned back when this
  // was shared, so nobody loses their shortcuts to the fix.
  const [shortcuts, setShortcuts] = useState<Shortcut[]>(
    () => fw.prefs.hostGet('files.shortcuts', DEFAULT_SHORTCUTS, 'files.shortcuts'))
  const cwdRef = useRef('~')
  const scroller = useRef<HTMLDivElement>(null)
  const anchor = useRef<string | null>(null)
  const lastPath = useRef('')

  // Keep directory loading independent of the title callback identity.
  const titleRef = useRef(setTitle)
  useEffect(() => { titleRef.current = setTitle })

  const load = useCallback(async (path: string, historyIndex?: number) => {
    const version = ++request.current
    setBusy(true); setErr(''); setNote('')
    try {
      const l = await fw.fs.list(path)
      if (version !== request.current) return
      if (path === '~') setHome(l.path)
      if (historyIndex !== undefined) history.current.index = historyIndex
      else if (history.current.paths[history.current.index] !== l.path) {
        const paths = [...history.current.paths.slice(0, history.current.index + 1), l.path]
        history.current = { paths, index: paths.length - 1 }
      }
      setD(l); setCwd(l.path); cwdRef.current = l.path; setSel(new Set()); anchor.current = null
      titleRef.current?.(`Files — ${l.path}`)
      if (l.path !== lastPath.current) {
        setQuery('')
        scroller.current?.scrollTo({ top: 0 })
        lastPath.current = l.path
      }
    } catch (e) {
      if (version === request.current) setErr(String(e))
    } finally { if (version === request.current) setBusy(false) }
  }, [fw])

  const goToFolder = async () => {
    const entered = await dlg.prompt({ title: 'Go to folder', label: 'Folder on this machine',
      value: cwd, placeholder: '/home/username', okLabel: 'Go' })
    if (entered) void load(entered)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(path); return () => { request.current++ } }, [])

  useEffect(() => { fw.prefs.hostSet('files.shortcuts', shortcuts) }, [fw, shortcuts])

  // One handler per window; the destination arrives as `arg` from the element.
  useDropTarget(dropId, (payload, { meta, arg }) => transfer(payload.paths, arg, meta))

  /**
   * Files dropped from Finder.
   *
   * Every explorer is in the same document, so all of them see the event.
   * Whichever one is actually under the cursor claims it, decided by hit
   * testing rather than by focus — the same way the internal drop targets
   * already work. If the cursor is over a directory row, that row wins;
   * otherwise the drop lands in the current directory.
   */
  useEffect(() => {
    let un: (() => void) | null = null
    let cancelled = false

    // Coordinate space is not something to assume here. Tauri types this as a
    // PhysicalPosition, but macOS works in points natively, so whether a scale
    // factor has already been applied differs by platform and version. Getting
    // it wrong lands the hit test somewhere near the top-left corner and the
    // drop is silently ignored — so try both and take whichever hits.
    const hit = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)
      if (!el) return null
      const zone = el.closest('[data-drop-id]') as HTMLElement | null
      if (zone && zone.dataset.dropId === dropId) return zone.dataset.dropArg || cwdRef.current
      // Dropped on this window but not on a drop zone (toolbar, status bar):
      // still ours, and the current directory is the obvious destination.
      if (root.current?.contains(el)) return cwdRef.current
      return null
    }

    const targetAt = (pos: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1
      return hit(pos.x / dpr, pos.y / dpr) ?? hit(pos.x, pos.y)
    }

    import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => {
      if (cancelled) return
      getCurrentWebview().onDragDropEvent(async ev => {
        const p = ev.payload as any
        if (p.type === 'over' || p.type === 'enter') {
          setOsDrop(!!targetAt(p.position))
          return
        }
        if (p.type === 'leave') { setOsDrop(false); return }
        if (p.type !== 'drop') return

        setOsDrop(false)
        const dest = targetAt(p.position)
        if (!dest) return
        if (!p.paths?.length) return

        setBusy(true); setErr(''); setNote('')
        try {
          setNote(await fw.fs.uploadFiles(p.paths, dest))
          await load(cwdRef.current)
          fw.bus.emit('fs:changed', { dirs: [dest] })
        } catch (e) { setErr(String(e)) } finally { setBusy(false) }
      }).then(f => { if (cancelled) f(); else un = f })
    })

    return () => { cancelled = true; un?.() }
  }, [dropId, fw, load])

  // Another window changed something in the directory we are showing.
  useEffect(() => fw.bus.on('fs:changed', (p: { dirs?: string[]; from?: number }) => {
    if (p?.from === selfId) return
    if (p?.dirs?.some(d => d === cwdRef.current)) load(cwdRef.current)
  }), [fw, load, selfId])

  const entries = useMemo(() => (d?.entries ?? []).filter(e =>
    (showHidden || !e.name.startsWith('.')) && e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  ), [d, query, showHidden])
  const navigateHistory = (offset: number) => {
    const index = history.current.index + offset
    const path = history.current.paths[index]
    if (path) void load(path, index)
  }
  const toggleHidden = () => { setShowHidden(v => !v); setSel(new Set()) }

  const act = async (fn: () => Promise<unknown>) => {
    setErr('')
    try {
      await fn()
      await load(cwd)
      fw.bus.emit('fs:changed', { dirs: [cwd], from: selfId })
    } catch (e) { setErr(String(e)) }
  }

  /**
   * Move or copy paths into `dest`. Used by both drag-and-drop and paste.
   * Refuses to drop a directory into itself or into its own subtree, which
   * would otherwise recurse until the disk fills.
   */
  const transfer = async (paths: string[], dest: string, move: boolean) => {
    setErr('')
    const bad = paths.find(p => dest === p || dest.startsWith(p + '/'))
    if (bad) { setErr(`cannot move ${fw.path.base(bad)} into itself`); return }
    try {
      let n = 0
      for (const src of paths) {
        const d = fw.path.join(dest, fw.path.base(src))
        if (src === d) continue
        if (move) await fw.fs.rename(src, d)
        else await fw.fs.copy(src, d)
        n++
      }
      const dirs = [dest, ...paths.map(p => fw.path.parent(p))]
      await load(cwdRef.current)
      fw.bus.emit('fs:changed', { dirs, from: selfId })
      setNote(`${move ? 'moved' : 'copied'} ${n} to ${dest}`)
    } catch (e) { setErr(String(e)) }
  }

  const virt = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 12,
  })

  const open = (e: Entry) => {
    const full = fw.path.join(cwd, e.name)
    if (e.kind === 'dir') return load(full)
    // Routed by content type. Apps declare what they handle, so this does not
    // grow a branch every time one is added; unclaimed types reach the editor,
    // which already decides for itself whether the bytes are text.
    fw.ui.open(handlerFor(full), { path: full })
  }

  /** Finder/Explorer selection: click replaces, cmd toggles, shift extends. */
  function selectRow(ev: React.MouseEvent, e: Entry, index: number) {
    const meta = ev.metaKey || ev.ctrlKey
    const shift = ev.shiftKey

    if (shift && anchor.current) {
      const a = entries.findIndex(x => x.name === anchor.current)
      if (a >= 0) {
        const [lo, hi] = a < index ? [a, index] : [index, a]
        const range = entries.slice(lo, hi + 1).map(x => x.name)
        setSel(meta ? new Set([...sel, ...range]) : new Set(range))
        return
      }
    }
    if (meta) {
      const n = new Set(sel)
      if (n.has(e.name)) n.delete(e.name)
      else n.add(e.name)
      setSel(n)
    } else {
      setSel(new Set([e.name]))
    }
    anchor.current = e.name
  }

  const selected = useMemo(() => entries.filter(e => sel.has(e.name)), [entries, sel])

  const one = selected.length === 1 ? selected[0] : null

  const removeList = async (list: Entry[]) => {
    const names = list.map(s => s.name)
    if (!names.length) return
    const label = names.length === 1 ? `"${names[0]}"` : `${names.length} items`
    const ok = await dlg.confirm({
      title: `Delete ${label}?`,
      message: names.length > 1 ? names.join(', ') : `in ${cwd}`,
      okLabel: 'Delete', danger: true,
    })
    if (!ok) return
    act(async () => {
      for (const s of list) {
        await fw.fs.remove(fw.path.join(cwd, s.name), s.kind === 'dir')
      }
    })
  }
  const removeSelected = () => removeList(selected)

  // Folders included: the backend walks them, so there is no reason to refuse.
  const downloadList = async (list: Entry[]) => {
    if (!list.length) { setErr('nothing selected'); return }
    setErr('')
    try {
      for (const f of list) await fw.fs.download(fw.path.join(cwd, f.name), f.name)
      setNote(`saved ${list.length} item${list.length > 1 ? 's' : ''} to ~/Downloads`)
    } catch (e) { setErr(String(e)) }
  }

  const pathsOf = (list: Entry[]) => list.map(e => fw.path.join(cwd, e.name))

  const copyList = (l: Entry[]) => { fw.clip.set('copy', pathsOf(l)); setNote(`copied ${l.length}`) }
  const cutList  = (l: Entry[]) => { fw.clip.set('cut',  pathsOf(l)); setNote(`cut ${l.length}`) }
  const copySel = () => copyList(selected)
  const cutSel  = () => cutList(selected)

  const paste = () => {
    const c = fw.clip.get()
    if (!c) return
    act(async () => {
      for (const src of c.paths) {
        const base = fw.path.base(src)
        let dest = fw.path.join(cwd, base)
        // Copying into the same directory would collide with the source.
        if (c.op === 'copy' && src === dest) dest = fw.path.join(cwd, `${base} copy`)
        if (c.op === 'copy') await fw.fs.copy(src, dest)
        else await fw.fs.rename(src, dest)
      }
      if (c.op === 'cut') fw.clip.clear()
    })
  }

  const renameEntry = async (e: Entry) => {
    const n = await dlg.prompt({ title: 'Rename', label: e.name, value: e.name, okLabel: 'Rename' })
    if (n && n !== e.name)
      act(() => fw.fs.rename(fw.path.join(cwd, e.name), fw.path.join(cwd, n)))
  }

  /**
   * Menu contents depend entirely on the passed-in context.
   *
   * The list is passed explicitly rather than read from `selected`: a
   * right-click may need to change the selection first, and that setState has
   * not committed yet when the menu is built.
   */
  function itemsForSelection(list: Entry[]): MenuItem[] {
    const many = list.length > 1
    const target = list.length === 1 ? list[0] : null
    const items: MenuItem[] = []

    if (target) {
      items.push({
        label: 'Open',
        icon: target.kind === 'dir' ? '\u{1F4C2}' : '\u{1F4DD}',
        shortcut: '\u23CE',
        onSelect: () => open(target),
      })
    }
    if (list.some(s => s.kind !== 'dir')) {
      items.push({ label: many ? 'Download selected' : 'Download', icon: '\u2B07',
                   onSelect: () => downloadList(list) })
    }
    if (items.length) items.push({ type: 'separator' })

    items.push({ label: 'Copy', icon: '\u29C9', shortcut: '\u2318C', onSelect: () => copyList(list) })
    items.push({ label: 'Cut',  icon: '\u2702', shortcut: '\u2318X', onSelect: () => cutList(list) })
    items.push({ label: 'Paste', icon: '\u{1F4CB}', shortcut: '\u2318V',
                 disabled: fw.clip.isEmpty(), onSelect: paste })
    items.push({ type: 'separator' })

    if (target) items.push({ label: 'Rename', icon: '\u270E', onSelect: () => renameEntry(target) })
    items.push({
      label: many ? `Delete ${list.length} items` : 'Delete',
      icon: '\u{1F5D1}', shortcut: '\u232B', danger: true,
      onSelect: () => removeList(list),
    })
    return items
  }

  /** Right-click on empty space acts on the directory itself. */
  function itemsForBackground(): MenuItem[] {
    return [
      { label: 'New folder', icon: '📁',
        onSelect: async () => {
          const n = await dlg.prompt({ title: 'New folder', label: `Create inside ${cwd}`,
                                       placeholder: 'folder name', okLabel: 'Create' })
          if (n) act(() => fw.fs.mkdir(fw.path.join(cwd, n)))
        } },
      { label: 'Paste', icon: '📋', shortcut: '⌘V', disabled: fw.clip.isEmpty(), onSelect: paste },
      { type: 'separator' },
      { label: 'Refresh', icon: '⟳', onSelect: () => load(cwd) },
    ]
  }

  const parts = cwd.split('/').filter(Boolean)

  return (
    <div
      ref={root}
      className="files-browser relative flex h-full bg-desk-panel text-desk-fg outline-none"
      tabIndex={0}
      onKeyDown={ev => {
        if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && ev.key.toLowerCase() === 'g') {
          ev.preventDefault(); void goToFolder(); return
        }
        if ((ev.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return
        if ((ev.metaKey || ev.ctrlKey) && ev.key === 'f') {
          ev.preventDefault(); searchInput.current?.focus(); return
        }
        if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && ev.code === 'Period') {
          ev.preventDefault(); toggleHidden(); return
        }
        if (ev.altKey && ev.key === 'ArrowLeft') { ev.preventDefault(); navigateHistory(-1); return }
        if (ev.altKey && ev.key === 'ArrowRight') { ev.preventDefault(); navigateHistory(1); return }
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault()
          const current = entries.findIndex(e => e.name === [...sel].at(-1))
          const next = current < 0 ? 0 : Math.max(0, Math.min(entries.length - 1, current + (ev.key === 'ArrowDown' ? 1 : -1)))
          if (entries[next]) { setSel(new Set([entries[next].name])); anchor.current = entries[next].name; virt.scrollToIndex(next) }
          return
        }
        if ((ev.metaKey || ev.ctrlKey) && ev.key === 'a') {
          ev.preventDefault(); setSel(new Set(entries.map(e => e.name)))
        } else if (ev.key === 'Escape') {
          setSel(new Set())
        } else if (ev.key === 'Enter' && one) {
          open(one)
        } else if ((ev.metaKey || ev.ctrlKey) && ev.key === 'c' && selected.length) {
          ev.preventDefault(); copySel()
        } else if ((ev.metaKey || ev.ctrlKey) && ev.key === 'x' && selected.length) {
          ev.preventDefault(); cutSel()
        } else if ((ev.metaKey || ev.ctrlKey) && ev.key === 'v') {
          ev.preventDefault(); paste()
        } else if ((ev.key === 'Backspace' || ev.key === 'Delete') && selected.length) {
          ev.preventDefault(); removeSelected()
        }
      }}
    >
      <FileSidebar
        cwd={cwd}
        home={home}
        shortcuts={shortcuts}
        dropId={dropId}
        onGo={load}
        onChange={setShortcuts}
      />

      <div className="flex flex-col flex-1 min-w-0">
      <div className="files-toolbar" role="toolbar" aria-label="File navigation">
        <button className="files-tool" title="Back (⌥←)" aria-label="Back" disabled={history.current.index <= 0 || busy}
          onClick={() => navigateHistory(-1)}><Icon id="lucide:chevron-left" size={17} /></button>
        <button className="files-tool" title="Forward (⌥→)" aria-label="Forward" disabled={history.current.index >= history.current.paths.length - 1 || busy}
          onClick={() => navigateHistory(1)}><Icon id="lucide:chevron-right" size={17} /></button>
        <button className="files-tool" title="Enclosing folder" aria-label="Enclosing folder" disabled={cwd === '/' || busy}
          onClick={() => load(fw.path.parent(cwd))}><Icon id="lucide:arrow-up" size={15} /></button>
        <span className="menubar-divider" />
        <button className="files-tool" title="Refresh" aria-label="Refresh" disabled={busy} onClick={() => load(cwd)}>
          <Icon id="lucide:rotate-cw" size={14} /></button>
        <button className="files-tool" title="New folder" aria-label="New folder" disabled={busy || !d}
          onClick={async () => {
            const n = await dlg.prompt({ title: 'New folder', label: `Create inside ${cwd}`, placeholder: 'Folder name', okLabel: 'Create' })
            if (n) act(() => fw.fs.mkdir(fw.path.join(cwd, n)))
          }}><Icon id="lucide:folder-plus" size={16} /></button>
        <button className="files-tool" title={`${showHidden ? 'Hide' : 'Show'} hidden files (⌘⇧.)`}
          aria-label="Show hidden files" aria-pressed={showHidden} onClick={toggleHidden}>
          <Icon id={showHidden ? 'lucide:eye' : 'lucide:eye-off'} size={16} /></button>
        <label className="files-search"><Icon id="lucide:search" size={13} />
          <input ref={searchInput} aria-label="Search this folder" placeholder="Search this folder" value={query} spellCheck={false}
            onChange={e => { setQuery(e.target.value); setSel(new Set()); scroller.current?.scrollTo({ top: 0 }) }}
            onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); root.current?.focus() } }} />
          {query && <button aria-label="Clear search" onClick={() => { setQuery(''); searchInput.current?.focus() }}>
            <Icon id="lucide:x" size={12} /></button>}
        </label>
      </div>
      <nav className="files-breadcrumbs" aria-label="Folder path">
        <button aria-label="File system" onClick={() => load('/')}><Icon id="lucide:hard-drive" size={13} /></button>
        {parts.map((part, i) => <span key={i} className="flex items-center gap-1 shrink-0">
          <Icon id="lucide:chevron-right" size={10} />
          <button aria-current={i === parts.length - 1 ? 'location' : undefined}
            onClick={() => load('/' + parts.slice(0, i + 1).join('/'))}>{part}</button>
        </span>)}
        <button className="files-go-to" title="Go to folder (⌘⇧G)" onClick={() => void goToFolder()}>Go to folder…</button>
      </nav>

      {err && (
        <div className="px-3 py-1.5 text-xs bg-desk-bad/15 text-desk-bad border-b border-desk-bad/30
                        shrink-0 select-text break-all">{err}</div>
      )}

      <div className="files-columns">
        <span className="flex-1">Name</span>
        <span className="w-20 text-right">Size</span>
        <span className="files-permissions w-24 pl-3">Permissions</span>
        <span className="files-modified w-32 pl-3">Modified</span>
      </div>

      {/* list — click the empty area below to clear the selection */}
      <div ref={scroller} {...dropProps(dropId, cwd)}
        data-os-drop={osDrop ? '1' : undefined}
        className={'flex-1 overflow-auto min-h-0' + (osDrop
          ? ' outline outline-2 -outline-offset-2 outline-desk-accent bg-desk-accent/5'
          : '')}
           onClick={ev => { if (ev.target === ev.currentTarget) setSel(new Set()) }}
           onContextMenu={ev => {
             if (ev.target === ev.currentTarget) { setSel(new Set()); menu.open(ev, itemsForBackground()) }
           }}
           >
        <div role="listbox" aria-label="Files and folders" aria-multiselectable="true" aria-busy={busy} style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map(v => {
            const e = entries[v.index]
            const isSel = sel.has(e.name)
            return (
              <div
                key={e.name}
                role="option" aria-selected={isSel} aria-label={e.name}
                data-selected={isSel} data-kind={e.kind}
                {...(e.kind === 'dir' ? dropProps(dropId, fw.path.join(cwd, e.name)) : {})}
                onPointerDown={ev => {
                  if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey) return
                  root.current?.focus()
                  const list = sel.has(e.name) ? selected : [e]
                  if (!sel.has(e.name)) setSel(new Set([e.name]))
                  const paths = list.map(x => fw.path.join(cwd, x.name))
                  const label = list.length === 1 ? list[0].name : `${list.length} items`

                  // Downloading is deferred until the drag actually arms, so a
                  // plain click never pulls bytes across the network.
                  let staging: Promise<string[]> | null = null

                  startDrag(ev, {
                    host: fw.host.current(),
                    paths,
                    label,
                    onArmed: () => { staging = fw.fs.stage(paths) },
                    // Left the window: the destination is Finder or another
                    // app, so hand the still-held gesture to the OS.
                    onLeaveWindow: () => {
                      setNote(`copying ${label} to your Mac\u2026`)
                      ;(staging ?? fw.fs.stage(paths))
                        .then(p => fw.fs.beginDrag(p))
                        .then(() => setNote(`${label} \u2192 dropped on your Mac`))
                        .catch(er => { setNote(''); setErr(String(er)) })
                    },
                  })
                }}
                onClick={ev => selectRow(ev, e, v.index)}
                onDoubleClick={() => open(e)}
                onContextMenu={ev => {
                  // Right-clicking outside the current selection selects that row
                  // first; right-clicking inside it keeps the multi-selection.
                  const eff = sel.has(e.name) ? selected : [e]
                  if (!sel.has(e.name)) { setSel(new Set([e.name])); anchor.current = e.name }
                  menu.open(ev, itemsForSelection(eff))
                }}
                style={{ position: 'absolute', top: 0, left: 0, right: 0,
                         height: ROW, transform: `translateY(${v.start}px)` }}
                className={`files-row flex items-center px-4 text-xs cursor-default select-none
                            ${drag?.over?.id === dropId
                                && drag.over.arg === fw.path.join(cwd, e.name)
                              ? 'bg-desk-accent/50 ring-1 ring-inset ring-desk-accent'
                              : isSel ? 'bg-desk-accent/30' : 'hover:bg-[var(--files-row-hover)]'}`}
              >
                <span className="file-icon w-6 shrink-0 flex items-center">
                  <Icon
                    token={e.kind === 'dir' ? 'files.directory'
                         : e.kind === 'link' ? 'files.link' : 'files.file'}
                    host={fw.host.current()} size={17} />
                </span>
                <span className="flex-1 truncate">
                  {e.name}
                </span>
                <span className="w-20 text-right text-desk-dim font-mono">
                  {e.kind === 'dir' ? '' : fw.fmt.size(e.size)}
                </span>
                <span className="files-permissions w-24 pl-3 text-desk-dim font-mono text-[10px]">{e.mode}</span>
                <span className="files-modified w-32 pl-3 text-desk-dim text-[11px]">{fw.fmt.time(e.mtime)}</span>
              </div>
            )
          })}
        </div>
        {busy && !d && <div className="files-loading" role="status"><span className="ui-spinner" /> Loading files…</div>}
        {!busy && entries.length === 0 && !err && (
          <div className="files-empty"><Icon id={query ? 'lucide:search' : 'desk:folder-open'} size={34} />
            <strong>{query ? 'No matching files' : 'This folder is empty'}</strong>
            <p>{query ? 'Try another name or show hidden files.' : 'Drag files here or create a new folder.'}</p>
          </div>
        )}
      </div>

      <footer className="files-status" role="status">
        {busy ? <><span className="ui-spinner" /><span>Loading…</span></> : <span>{entries.length} {entries.length === 1 ? 'item' : 'items'}</span>}
        {selected.length > 0 && <span className="text-desk-fg">· {selected.length} selected</span>}
        {!showHidden && !!d?.entries.some(e => e.name.startsWith('.')) && <span>· Hidden files off</span>}
        {note && <span className="text-desk-ok">{note}</span>}
        {d && d.disk.total > 0 && <span className="files-status-space">{fw.fmt.size(d.disk.avail)} available</span>}
      </footer>
      </div>
    </div>
  )
}
