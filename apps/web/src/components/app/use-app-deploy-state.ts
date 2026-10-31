import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { appDeployStatesQueryOptions } from "@/lib/query-options"

export interface AppDeployState {
  /** Hearth is running a deployment of the app. */
  readonly deploying: boolean
  /** The ask waiting its turn, to cancel, when one is. */
  readonly queuedRevision: number | null
}

/**
 * The app's deploy as Hearth has it: waiting its turn, running, or neither,
 * from the moment it's asked. Re-renders only when this app's changes.
 */
export function useAppDeployState(appId: string): AppDeployState | null {
  const select = React.useCallback(
    (states: Record<string, AppDeployState>) => states[appId] ?? null,
    [appId]
  )
  return useQuery({ ...appDeployStatesQueryOptions(), select }).data ?? null
}
