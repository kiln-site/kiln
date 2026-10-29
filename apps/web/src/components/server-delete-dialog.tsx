import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Effect } from "effect"
import { LoaderCircle, Trash2, TriangleAlert } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"

import {
  DeleteConfirmationFields,
  useDeleteConfirmation,
} from "@/components/delete-confirmation-fields"
import { FinalBackupFields } from "@/components/final-backup-fields"
import { applyDeletedInstance } from "@/lib/realtime-client"
import { deleteInstance } from "@/server/relay"

export interface ServerDeleteTarget {
  backupAvailable: boolean
  id: string
  name: string
  relayId: string
}

export const ServerDeleteDialog = React.memo(function ServerDeleteDialog({
  open,
  target,
  onDeleted,
  onOpenChange,
}: {
  open: boolean
  target: ServerDeleteTarget
  onDeleted?: () => Promise<void> | void
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const confirmation = useDeleteConfirmation(target.name)
  const [error, setError] = React.useState<string | null>(null)
  const [createBackup, setCreateBackup] = React.useState(target.backupAvailable)
  const [backupDestination, setBackupDestination] = React.useState("default")
  const deletion = useMutation({
    mutationFn: deleteInstance,
    onSuccess: () =>
      applyDeletedInstance(queryClient, {
        instanceId: target.id,
        relayId: target.relayId,
      }),
  })
  const pending = deletion.isPending
  const changeCreateBackup = React.useCallback((nextCreateBackup: boolean) => {
    setCreateBackup(nextCreateBackup)
    setError(null)
  }, [])

  const changeOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (pending) return
      onOpenChange(nextOpen)
    },
    [onOpenChange, pending]
  )

  async function removeServer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!confirmation.ready || pending) return
    setError(null)
    const deleted = await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          deletion.mutateAsync({
            data: {
              ...confirmation.input,
              createBackup,
              instanceId: target.id,
              relayId: target.relayId,
              ...(createBackup && backupDestination !== "default"
                ? {
                    storageId:
                      backupDestination === "local" ? null : backupDestination,
                  }
                : {}),
            },
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: (cause) => {
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not delete the server."
            )
            return false
          },
          onSuccess: () => true,
        })
      )
    )
    if (!deleted) return

    showToast({
      type: "success",
      message: `${target.name} deleted`,
      description: createBackup
        ? "The final backup was saved and the server data was removed."
        : "The server and its stored data were removed without a final backup.",
      duration: 5_000,
    })
    onOpenChange(false)
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => onDeleted?.(),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => window.location.assign("/infra/servers"))
        )
      )
    )
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-xl" showCloseButton={!pending}>
        <DialogHeader>
          <div className="mb-2 flex size-9 items-center justify-center rounded-lg border border-destructive/25 bg-destructive/10 text-destructive light:bg-destructive/20">
            <TriangleAlert className="size-4" />
          </div>
          <DialogTitle>Delete {target.name}?</DialogTitle>
          <DialogDescription>
            This permanently removes the server, its container, and all data in
            its managed server directory. Schedules left with nothing else to
            run on are deleted too.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => void removeServer(event)}
        >
          <FinalBackupFields
            available={target.backupAvailable}
            createBackup={createBackup}
            destination={backupDestination}
            label="Back up server before deleting"
            open={open}
            pending={pending}
            unavailable="Unavailable because this server never finished provisioning."
            onCreateBackupChange={changeCreateBackup}
            onDestinationChange={setBackupDestination}
          />

          <DeleteConfirmationFields
            confirmation={confirmation}
            disabled={pending}
          />

          {error ? (
            <p role="alert" className="type-meta text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={!confirmation.ready || pending}
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              {pending ? "Deleting server…" : "Delete server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
})
