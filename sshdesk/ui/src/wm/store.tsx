import { createContext, useContext, useReducer, type ReactNode } from 'react'

import { reducer, type State, type Action } from './windowState'
export type { Win } from './windowState'

const Ctx = createContext<{ state: State; dispatch: React.Dispatch<Action> } | null>(null)

export function WindowProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { wins: [], topZ: 0 })
  return <Ctx.Provider value={{ state, dispatch }}>{children}</Ctx.Provider>
}

export function useWM() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useWM outside WindowProvider')
  return c
}

let seq = 0
export const nextId = (appId: string) => `${appId}-${++seq}`
