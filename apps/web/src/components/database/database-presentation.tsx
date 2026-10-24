import { instanceStatePresentation } from "@/lib/instance-state-presentation"
import type { DatabaseEngine } from "@workspace/contracts"

import { showToast } from "@workspace/ui/components/sonner"

import { instanceStatusPresentation } from "@/components/instance-name-presentation"
import type { ManagedDatabaseListItem } from "@/server/databases"

export type ManagedDatabase = Omit<ManagedDatabaseListItem, "observedState"> & {
  relayStatus: "connected" | "unreachable"
  relayUpdating: boolean
  observedState: import("@workspace/contracts").RelayObservedState | undefined
  runtimeStatus?: import("@/lib/instance-state").InstanceState
}

export const engineOptions: ReadonlyArray<{
  description: string
  label: string
  value: DatabaseEngine
}> = [
  { value: "mysql", label: "MySQL", description: "8.4 LTS" },
  { value: "mariadb", label: "MariaDB", description: "11.8 LTS" },
  { value: "postgres", label: "Postgres", description: "17" },
  { value: "redis", label: "Redis", description: "8" },
  { value: "valkey", label: "Valkey", description: "8" },
]

export const engineBadgeClasses: Record<DatabaseEngine, string> = {
  mariadb:
    "border-amber-500/35 bg-amber-500/10 light:bg-amber-500/20 text-amber-700 dark:text-amber-300",
  mysql:
    "border-sky-500/35 bg-sky-500/10 light:bg-sky-500/20 text-sky-700 dark:text-sky-300",
  postgres:
    "border-emerald-500/35 bg-emerald-500/10 light:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  redis:
    "border-red-500/35 bg-red-500/10 light:bg-red-500/20 text-red-700 dark:text-red-300",
  valkey:
    "border-violet-500/35 bg-violet-500/10 light:bg-violet-500/20 text-violet-700 dark:text-violet-300",
}

export function databaseStatusPresentation(
  database: Pick<
    ManagedDatabase,
    "inventoryStatus" | "observedState" | "relayStatus" | "relayUpdating"
  > & { runtimeStatus?: import("@/lib/instance-state").InstanceState }
) {
  if (database.runtimeStatus)
    return instanceStatePresentation(database.runtimeStatus)
  return instanceStatusPresentation({
    id: "status-presentation",
    inventoryStatus: database.inventoryStatus,
    kind: "database",
    observedState: database.observedState,
    relayId: "status-presentation",
    relayStatus: database.relayStatus,
    relayUpdating: database.relayUpdating,
  })
}

// Inventory says whether the database exists; relayStatus follows live Relay
// reachability between inventory refreshes.
export function databaseRelayAvailable(
  database: Pick<ManagedDatabase, "inventoryStatus" | "relayStatus"> & {
    runtimeStatus?: import("@/lib/instance-state").InstanceState
  }
): boolean {
  const state = database.runtimeStatus
  if (state)
    return (
      state.phase === "ready" &&
      state.observation.reachability === "connected" &&
      state.observation.inventory === "available"
    )
  return (
    database.inventoryStatus === "available" &&
    database.relayStatus === "connected"
  )
}

// The engine's full name, as its makers write it.
const engineProductNames: Record<DatabaseEngine, string> = {
  mariadb: "MariaDB",
  mysql: "MySQL",
  postgres: "PostgreSQL",
  redis: "Redis",
  valkey: "Valkey",
}

// The engine and the version its image runs, such as "PostgreSQL 17".
export function engineProductLabel(
  database: Pick<ManagedDatabase, "engine" | "image">
): string {
  const version = database.image.split(":").at(1)
  const name = engineProductNames[database.engine]
  return version ? `${name} ${version}` : name
}

export function engineLabel(engine: DatabaseEngine): string {
  return (
    engineOptions.find((option) => option.value === engine)?.label ?? engine
  )
}

export function showDatabaseOperationError(message: string, error: Error) {
  showToast({
    message: `${message}: ${error.message}`,
    type: "error",
  })
}
