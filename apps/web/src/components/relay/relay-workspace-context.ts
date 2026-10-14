import * as React from "react"

import type { RelayDirectoryEntry } from "@/lib/relay-route"

export interface RelayWorkspaceRelay {
  relay: RelayDirectoryEntry
  // The route segment for this Relay, for links between its pages.
  routeId: string
}

// Keep context identity outside the Fast Refresh boundary for workspace UI.
export const RelayWorkspaceContext =
  React.createContext<RelayWorkspaceRelay | null>(null)

export function useRelayWorkspace(): RelayWorkspaceRelay {
  const value = React.useContext(RelayWorkspaceContext)
  if (value === null) {
    throw new Error("useRelayWorkspace must be used within RelayWorkspace")
  }
  return value
}
