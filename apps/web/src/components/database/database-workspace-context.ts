import * as React from "react"

import type { ManagedDatabase } from "@/components/database/database-presentation"

export interface DatabaseWorkspaceDatabase {
  database: ManagedDatabase
}

// Keep context identity outside the Fast Refresh boundary for workspace UI.
export const DatabaseWorkspaceContext =
  React.createContext<DatabaseWorkspaceDatabase | null>(null)

export function useDatabaseWorkspace(): DatabaseWorkspaceDatabase {
  const value = React.useContext(DatabaseWorkspaceContext)
  if (value === null) {
    throw new Error(
      "useDatabaseWorkspace must be used within DatabaseWorkspace"
    )
  }
  return value
}
