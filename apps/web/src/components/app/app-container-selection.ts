import * as React from "react"

// Which service's container the Info rail's Container card shows. The card
// pages through them, and the page's service tags, such as a route's
// target, select one. Only the card subscribes, so selecting re-renders
// nothing else.
export interface AppContainerSelection {
  get: () => string | null
  select: (service: string) => void
  subscribe: (listener: () => void) => () => void
}

export function createAppContainerSelection(): AppContainerSelection {
  let selected: string | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => selected,
    select: (service) => {
      if (service === selected) return
      selected = service
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// Kept outside the Fast Refresh boundary, like the workspace context.
export const AppContainerSelectionContext =
  React.createContext<AppContainerSelection | null>(null)

export function useAppContainerSelection(): AppContainerSelection | null {
  return React.useContext(AppContainerSelectionContext)
}
