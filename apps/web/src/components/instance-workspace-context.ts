import * as React from "react"

import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"

export interface InstanceWorkspacePermissions {
  consoleRead: boolean
  consoleWrite: boolean
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
export const InstanceIdentityContext =
  React.createContext<InstanceWorkspaceInstance | null>(null)
export const InstancePermissionsContext =
  React.createContext<InstanceWorkspacePermissions | null>(null)
export const FileTreePreferencesContext =
  React.createContext<FileTreePreferences | null>(null)
export const InstanceRelayConnectedContext = React.createContext<
  boolean | null
>(null)

function useRequiredContext<T>(
  context: React.Context<T | null>,
  hookName: string
): T {
  const value = React.useContext(context)
  if (value === null) {
    throw new Error(`${hookName} must be used within InstanceWorkspace`)
  }
  return value
}

export function useInstanceIdentity() {
  return useRequiredContext(InstanceIdentityContext, "useInstanceIdentity")
}

export function useInstancePermissions() {
  return useRequiredContext(
    InstancePermissionsContext,
    "useInstancePermissions"
  )
}

export function useFileTreePreferences() {
  return useRequiredContext(
    FileTreePreferencesContext,
    "useFileTreePreferences"
  )
}

export function useInstanceRelayConnected() {
  return useRequiredContext(
    InstanceRelayConnectedContext,
    "useInstanceRelayConnected"
  )
}
