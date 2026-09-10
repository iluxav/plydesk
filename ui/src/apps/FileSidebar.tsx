import { fw } from '../fw'
import { Icon } from '../wm/Icon'
import { useContextMenu, type MenuItem } from '../wm/ContextMenu'
import { useDrag, dropProps } from '../wm/dnd'
import { useDialog } from '../wm/Dialog'

export interface Shortcut { label: string; path: string; icon: string }

export const DEFAULT_SHORTCUTS: Shortcut[] = [
  { label: 'Home',    path: '~',        icon: 'lucide:house' },
  { label: 'File system', path: '/', icon: 'lucide:hard-drive' },
  { label: 'Configuration', path: '/etc', icon: 'lucide:settings-2' },
  { label: 'Logs', path: '/var/log', icon: 'lucide:scroll-text' },
  { label: 'Temporary', path: '/tmp', icon: 'lucide:folder' },
  { label: 'Applications', path: '/opt', icon: 'lucide:package' },
]

export function FileSidebar({
  cwd, home, shortcuts, dropId, onGo, onChange,
}: {
  cwd: string
  home: string
  shortcuts: Shortcut[]
  dropId: string
  onGo: (path: string) => void
  onChange: (next: Shortcut[]) => void
}) {
  const menu = useContextMenu()
  const { drag } = useDrag()
  const dlg = useDialog()

  const itemsFor = (s: Shortcut, i: number): MenuItem[] => [
    { label: 'Open', icon: '📂', onSelect: () => onGo(s.path) },
    { type: 'separator' },
    {
      label: 'Rename shortcut', icon: '✎',
      onSelect: async () => {
        const n = await dlg.prompt({ title: 'Rename shortcut', value: s.label, okLabel: 'Rename' })
        if (n) onChange(shortcuts.map((x, j) => (j === i ? { ...x, label: n } : x)))
      },
    },
    {
      label: 'Remove shortcut', icon: '🗑', danger: true,
      onSelect: () => onChange(shortcuts.filter((_, j) => j !== i)),
    },
  ]

  const pinned = shortcuts.some(s => s.path === cwd || (s.path === '~' && cwd === home))

  return (
    <div className="files-sidebar">
      <div className="files-sidebar-heading">
        Favorites
      </div>

      <div className="files-sidebar-list">
        {shortcuts.map((s, i) => {
          const active = cwd === s.path || (s.path === '~' && cwd === home)
          const isOver = drag?.over?.id === dropId && drag.over.arg === s.path
          return (
            <button
              key={s.path + i}
              {...dropProps(dropId, s.path)}
              onClick={() => onGo(s.path)}
              onContextMenu={ev => menu.open(ev, itemsFor(s, i))}
              aria-current={active ? 'location' : undefined}
              className={`files-shortcut ${isOver ? 'is-drop' : active ? 'is-active' : ''}`}
            >
              <Icon id={s.icon.includes(':') ? s.icon : ({
                '🏠': 'lucide:house', '💽': 'lucide:hard-drive', '⚙️': 'lucide:settings-2',
                '📜': 'lucide:scroll-text', '🗂': 'lucide:folder', '📦': 'lucide:package', '📌': 'lucide:pin',
              } as Record<string, string>)[s.icon] || s.icon} size={15} />
              <span className="truncate pointer-events-none">{s.label}</span>
            </button>
          )
        })}
      </div>

      <button
        disabled={pinned}
        onClick={() => onChange([...shortcuts, { label: fw.path.base(cwd) || '/', path: cwd, icon: 'lucide:pin' }])}
        className="files-pin"
      >
        <Icon id="lucide:pin" size={12} />{pinned ? 'In Favorites' : 'Add to Favorites'}
      </button>
    </div>
  )
}
