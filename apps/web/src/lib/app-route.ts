import type { getAppDirectory } from "@/server/apps"
import { instanceSelection } from "@/lib/instance-selection"

export type AppDirectoryEntry = Awaited<
  ReturnType<typeof getAppDirectory>
>[number]

const appSelection = instanceSelection("app")
export const appSelectionValue = appSelection.toSelection
export const appIdFromSelection = appSelection.fromSelection
