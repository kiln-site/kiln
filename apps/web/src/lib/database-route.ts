import type { getManagedDatabaseDirectory } from "@/server/databases"
import { instanceSelection } from "@/lib/instance-selection"

export type ManagedDatabaseDirectoryEntry = Awaited<
  ReturnType<typeof getManagedDatabaseDirectory>
>[number]

const databaseSelection = instanceSelection("db")
export const databaseSelectionValue = databaseSelection.toSelection
export const databaseIdFromSelection = databaseSelection.fromSelection
