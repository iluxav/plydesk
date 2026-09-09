import { useEffect, type RefObject } from 'react'

/** Keep keyboard focus in a modal and return it to the control that opened it. */
export function useModalFocus(ref: RefObject<HTMLElement | null>, open: boolean) {
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const node = ref.current
    if (!node) return
    const controls = () => [...node.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
    )].filter(el => el.getClientRects().length > 0)
    const frame = requestAnimationFrame(() => (node.querySelector<HTMLElement>('[data-autofocus]') ?? controls()[0] ?? node).focus())
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const list = controls()
      const first = list[0], last = list.at(-1)
      if (!first) { event.preventDefault(); node.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) {
        event.preventDefault(); last?.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    node.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      node.removeEventListener('keydown', onKey)
      if (previous?.isConnected) previous.focus()
    }
  }, [open, ref])
}
