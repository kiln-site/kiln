import * as React from "react"

// Which container the Info page's Container section shows. It pages
// through them by ID, and the page's service tags, such as a route's
// target, pick a service's container. Only the section subscribes, so
// selecting re-renders nothing else.
export interface AppContainerTarget {
  // While a redeploy replaces a container, two share a service, so paging
  // picks one by ID; a service tag leaves it out.
  containerId?: string
  service: string
}

export interface AppContainerSelection {
  get: () => AppContainerTarget | null
  select: (target: AppContainerTarget) => void
  subscribe: (listener: () => void) => () => void
}

export function createAppContainerSelection(): AppContainerSelection {
  let selected: AppContainerTarget | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => selected,
    select: (target) => {
      if (
        selected?.service === target.service &&
        selected.containerId === target.containerId
      ) {
        return
      }
      selected = target
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
