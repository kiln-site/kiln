import * as React from "react"

import type { TunnelView } from "@/components/tunnel/tailnet-data"

// Keep context identity outside the Fast Refresh boundary for workspace UI.
export const TunnelWorkspaceContext = React.createContext<TunnelView | null>(
  null
)

export function useTunnelWorkspace(): TunnelView {
  const value = React.useContext(TunnelWorkspaceContext)
  if (value === null) {
    throw new Error("useTunnelWorkspace must be used within TunnelWorkspace")
  }
  return value
}
