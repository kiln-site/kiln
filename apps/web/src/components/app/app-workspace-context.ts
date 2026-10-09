import * as React from "react"

import type { App } from "@/components/app/app-presentation"

export interface AppWorkspaceApp {
  app: App
  // The route segment for this app, for links between its pages.
  routeId: string
}

// Keep context identity outside the Fast Refresh boundary for workspace UI.
export const AppWorkspaceContext = React.createContext<AppWorkspaceApp | null>(
  null
)

export function useAppWorkspace(): AppWorkspaceApp {
  const value = React.useContext(AppWorkspaceContext)
  if (value === null) {
    throw new Error("useAppWorkspace must be used within AppWorkspace")
  }
  return value
}
