import type { DatabaseEngine } from "@workspace/contracts"

import { showToast } from "@workspace/ui/components/sonner"

import { instanceStatusPresentation } from "@/components/instance-name-presentation"
import type { getManagedDatabases } from "@/server/databases"

export type ManagedDatabaseOverview = Awaited<
  ReturnType<typeof getManagedDatabases>
>
export type ManagedDatabase = ManagedDatabaseOverview["databases"][number]

export const DATABASE_DUMP_LIMIT_BYTES = 700_000

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
    "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  mysql: "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  postgres:
    "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  redis: "border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-300",
  valkey:
    "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300",
}

export function databaseStatusPresentation(
  database: Pick<
    ManagedDatabase,
    "inventoryStatus" | "observedState" | "relayUpdating"
  >
) {
  return instanceStatusPresentation({
    id: "status-presentation",
    inventoryStatus: database.inventoryStatus,
    kind: "database",
    observedState: database.observedState,
    relayId: "status-presentation",
    relayUpdating: database.relayUpdating,
  })
}

export function engineLabel(engine: DatabaseEngine): string {
  return (
    engineOptions.find((option) => option.value === engine)?.label ?? engine
  )
}

export function downloadTextFile(fileName: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/sql" })
  )
  const link = document.createElement("a")
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

export function showDatabaseOperationError(message: string, error: Error) {
  showToast({
    message: `${message}: ${error.message}`,
    type: "error",
  })
}
