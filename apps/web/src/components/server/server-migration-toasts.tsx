import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Option, Result, Schema } from "effect"

import { dismissToast, showToast } from "@workspace/ui/components/sonner"

import { formatBytes } from "@/lib/format-bytes"
import { serverMigrationsQueryOptions } from "@/lib/server-migration-queries"
import type { ServerMigrationView } from "@/lib/server-migrations.server"
import { cancelServerMigration } from "@/server/server-migrations"

// Copies whose toast someone closed stay closed across reloads; how each
// ended still arrives as a notification.
const dismissedStorageKey = "kiln.serverMigrationToasts.dismissed"

const DismissedIds = Schema.fromJsonString(Schema.Array(Schema.String))

function readDismissed(): Set<string> {
  const stored = Result.try(() =>
    window.localStorage.getItem(dismissedStorageKey)
  )
  const ids = Result.isSuccess(stored)
    ? Schema.decodeUnknownOption(DismissedIds)(stored.success ?? "[]")
    : Option.none()
  return new Set(Option.getOrElse(ids, () => []))
}

function saveDismissed(ids: ReadonlySet<string>) {
  // Storage may be full or off; the toast just comes back next load.
  Result.try(() =>
    window.localStorage.setItem(
      dismissedStorageKey,
      JSON.stringify([...ids].slice(-50))
    )
  )
}

/**
 * A progress toast for each of the person's game server copies while it
 * runs, which they can close or use to cancel it. How a copy ended arrives
 * as a notification, so a closed toast or tab misses nothing.
 */
export const ServerMigrationToasts = React.memo(
  function ServerMigrationToasts() {
    const queryClient = useQueryClient()
    const { data } = useQuery(serverMigrationsQueryOptions())
    const dismissed = React.useRef<Set<string> | null>(null)
    const shown = React.useRef(new Set<string>())
    const cancel = useMutation({
      mutationFn: (id: string) => cancelServerMigration({ data: { id } }),
      onError: (error) =>
        showToast({
          message: "Couldn't cancel the copy",
          description: error.message,
          type: "error",
        }),
      onSettled: () =>
        queryClient.invalidateQueries({
          queryKey: serverMigrationsQueryOptions().queryKey,
        }),
    })
    const cancelCopy = cancel.mutate

    React.useEffect(() => {
      if (!data) return
      dismissed.current ??= readDismissed()
      const closed = dismissed.current
      for (const migration of data) {
        const toastId = migrationToastId(migration.id)
        const running =
          migration.state === "running" || migration.state === "cancelling"
        if (!running || closed.has(migration.id)) {
          if (shown.current.delete(migration.id)) dismissToast(toastId)
          continue
        }
        shown.current.add(migration.id)
        showToast({
          action:
            migration.cancellable
              ? { label: "Cancel", onClick: () => cancelCopy(migration.id) }
              : undefined,
          description: migrationProgress(migration),
          dismissible: true,
          duration: Number.POSITIVE_INFINITY,
          id: toastId,
          message:
            migration.mode === "migrate"
              ? `Moving ${migration.source.name}`
              : `Duplicating ${migration.source.name}`,
          onDismiss: () => {
            closed.add(migration.id)
            shown.current.delete(migration.id)
            saveDismissed(closed)
          },
          type: "loading",
        })
      }
    }, [cancelCopy, data])

    return null
  }
)

function migrationToastId(id: string) {
  return `server-migration:${id}`
}

function migrationProgress(migration: ServerMigrationView): string {
  if (migration.state === "cancelling") return "Cancelling and cleaning up…"
  switch (migration.step) {
    case "backup":
      return "Backing up first…"
    case "stop":
      return "Stopping the server…"
    case "create":
    case "provision":
      return "Creating the new server…"
    case "copy": {
      if (!migration.totalBytes) return "Packing its files…"
      const percent = Math.min(
        99,
        Math.floor((migration.receivedBytes / migration.totalBytes) * 100)
      )
      return `Copying files · ${percent}% of ${formatBytes(migration.totalBytes)}`
    }
    case "finish":
      return "Carrying over its settings…"
  }
}
