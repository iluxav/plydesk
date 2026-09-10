/** The desktop uses native commands; app views use the checked runtime gateway. */
import { invoke as nativeInvoke } from '@tauri-apps/api/core'
type Invoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>
let implementation: Invoker = (command, args) => nativeInvoke(command, args)
export const invoke: Invoker = (command, args) => implementation(command, args)
export function installRuntimeGateway() {
  implementation = (command, args = {}) => nativeInvoke('runtime_call', { command, args })
}
