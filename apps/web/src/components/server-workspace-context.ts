import * as React from "react"

import type { WorkspaceServer } from "@/lib/relay-selectors"

export interface ServerWorkspacePermissions {
  consoleRead: boolean
  consoleWrite: boolean
  copyServer: boolean
  deleteServer: boolean
  filesWrite: boolean
  networkRead: boolean
  networkPublicPortWrite: boolean
  networkWrite: boolean
  powerStart: boolean
  powerRestart: boolean
  configurationRead: boolean
  configurationWrite: boolean
  limitsWrite: boolean
  shareLogs: boolean
}

export interface FileTreePreferences {
  collapsed: boolean
  width: number | null
}

// Keep context identity outside the Fast Refresh boundary for workspace UI.
export const ServerIdentityContext =
  React.createContext<WorkspaceServer | null>(null)
export const ServerPermissionsContext =
  React.createContext<ServerWorkspacePermissions | null>(null)
export const FileTreePreferencesContext =
  React.createContext<FileTreePreferences | null>(null)
export const ServerRelayConnectedContext = React.createContext<boolean | null>(
  null
)

function useRequiredContext<T>(
  context: React.Context<T | null>,
  hookName: string
): T {
  const value = React.useContext(context)
  if (value === null) {
    throw new Error(`${hookName} must be used within ServerWorkspace`)
  }
  return value
}

export function useServerIdentity() {
  return useRequiredContext(ServerIdentityContext, "useServerIdentity")
}

export function useServerPermissions() {
  return useRequiredContext(ServerPermissionsContext, "useServerPermissions")
}

export function useFileTreePreferences() {
  return useRequiredContext(
    FileTreePreferencesContext,
    "useFileTreePreferences"
  )
}

export function useServerRelayConnected() {
  return useRequiredContext(
    ServerRelayConnectedContext,
    "useServerRelayConnected"
  )
}
