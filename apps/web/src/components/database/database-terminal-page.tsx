import * as React from "react"
import { Play } from "lucide-react"

import { useDatabaseWorkspace } from "@/components/database/database-workspace-context"

const DatabaseTerminal = React.lazy(async () => {
  const module = await import("@/components/database/database-terminal")
  return { default: module.DatabaseTerminal }
})

export function DatabaseTerminalPage() {
  const { database } = useDatabaseWorkspace()

  if (database.observedState !== "running") {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
        <div className="max-w-sm">
          <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground">
            <Play className="size-5" />
          </div>
          <p className="text-sm font-semibold">
            {database.name} is not running
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            Start the database to open its terminal.
          </p>
        </div>
      </div>
    )
  }

  return (
    <React.Suspense fallback={<div className="min-h-0 flex-1 bg-card" />}>
      <DatabaseTerminal
        key={`${database.relayId}:${database.id}`}
        databaseId={database.id}
        relayId={database.relayId}
      />
    </React.Suspense>
  )
}
