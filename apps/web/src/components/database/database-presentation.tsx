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
  inventoryStatus: ManagedDatabase["inventoryStatus"],
  state: ManagedDatabase["observedState"]
) {
  const status = instanceStatusPresentation({
    id: "status-presentation",
    inventoryStatus,
    kind: "database",
    observedState: state,
    relayId: "status-presentation",
  })
  return {
    dot: databaseStatusToneClasses[status.tone].dot,
    label: status.label,
    text: databaseStatusToneClasses[status.tone].text,
  }
}

const databaseStatusToneClasses = {
  danger: { dot: "bg-destructive", text: "text-destructive" },
  info: { dot: "bg-sky-400", text: "text-sky-300" },
  neutral: {
    dot: "bg-muted-foreground",
    text: "text-muted-foreground",
  },
  success: { dot: "bg-emerald-400", text: "text-emerald-300" },
  warning: { dot: "bg-amber-300", text: "text-amber-200" },
} as const

export function DatabaseStatus({
  status,
}: {
  status: ReturnType<typeof databaseStatusPresentation>
}) {
  return (
    <span
      aria-label={status.label}
      className={`type-label inline-flex items-center gap-1.5 ${status.text}`}
    >
      <span className={`size-1.5 rounded-full ${status.dot}`} />
      <span className="hidden sm:inline">{status.label}</span>
    </span>
  )
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
