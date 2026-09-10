import { listen } from '@tauri-apps/api/event'
export interface RuntimeInfo { label: string; appId: string; name: string; directory: string; host: string; winId: string }
export interface RuntimeEvent { runtime: RuntimeInfo; kind: string; payload: any }
const subscribers = new Set<(event: RuntimeEvent) => void>()
const last = new Map<string, RuntimeEvent[]>()
let ready: Promise<void> | undefined
export function runtimeEventsReady() {
  return ready ??= listen<RuntimeEvent>('app-runtime-event', event => {
    const e = event.payload
    if (['ready','error','embedded'].includes(e.kind)) {
      const previous = last.get(e.runtime.label) || []
      last.set(e.runtime.label, [...previous.filter(p => p.kind !== e.kind), e])
    }
    subscribers.forEach(fn => fn(e))
  }).then(() => {})
}
export function onRuntimeEvent(fn: (event: RuntimeEvent) => void) {
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}
export function replayRuntime(label: string, fn: (event: RuntimeEvent) => void) { last.get(label)?.forEach(fn) }
export function forgetRuntime(label: string) { last.delete(label) }
