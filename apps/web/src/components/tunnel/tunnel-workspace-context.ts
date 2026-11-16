import * as React from "react"

import type { AccessPermission } from "@/lib/permissions"
import type { TunnelOverview } from "@/components/tunnel/tunnel-data"

/** A tunnel's pages' subject: it, and what the viewer may do with it. */
export interface TunnelWorkspaceValue {
  permissions: ReadonlyArray<AccessPermission>
  tunnel: TunnelOverview
}

// Keep context identity outside the Fast Refresh boundary for workspace UI.
export const TunnelWorkspaceContext =
  React.createContext<TunnelWorkspaceValue | null>(null)

export function useTunnelWorkspace(): TunnelWorkspaceValue {
  const value = React.useContext(TunnelWorkspaceContext)
  if (value === null) {
    throw new Error("useTunnelWorkspace must be used within TunnelWorkspace")
  }
  return value
}
