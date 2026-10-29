import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Effect } from "effect"
import { Archive, LoaderCircle, Trash2, TriangleAlert } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"

import {
  DeleteConfirmationFields,
  useDeleteConfirmation,
} from "@/components/delete-confirmation-fields"
import { backupStorageQueryOptions } from "@/lib/query-options"
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
            open={open}
            pending={pending}
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

const FinalBackupFields = React.memo(function FinalBackupFields({
  available,
  createBackup,
  destination,
  open,
  pending,
  onCreateBackupChange,
  onDestinationChange,
}: {
  available: boolean
  createBackup: boolean
  destination: string
  open: boolean
  pending: boolean
  onCreateBackupChange: (createBackup: boolean) => void
  onDestinationChange: (destination: string) => void
}) {
  const backupStorage = useQuery({
    ...backupStorageQueryOptions(),
    enabled: open && available && createBackup,
  })
  const availableStorage = React.useMemo(
    () =>
      (backupStorage.data ?? []).filter(
        (candidate) => candidate.enabled && !candidate.deleting
      ),
    [backupStorage.data]
  )

  return (
    <div className="grid gap-3 rounded-lg border border-border/80 bg-background/45 p-3">
      <label
        className={`flex items-start gap-3 ${
          available ? "cursor-pointer" : "cursor-not-allowed opacity-60"
        }`}
      >
        <input
          aria-label="Back up server before deleting"
          checked={createBackup}
          className="mt-0.5 size-4 rounded-[3px] border-input accent-primary"
          disabled={!available || pending}
          type="checkbox"
          onChange={(event) =>
            onCreateBackupChange(event.currentTarget.checked)
          }
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Archive className="size-4 text-muted-foreground" />
            Back up server before deleting
          </span>
          {available ? null : (
            <span className="type-meta mt-1 block text-muted-foreground">
              Unavailable because this server never finished provisioning.
            </span>
          )}
        </span>
      </label>

      <label className="grid gap-1.5 border-t border-border/70 pt-3">
        <span className="type-technical-label text-muted-foreground">
          Backup destination
        </span>
        <Select
          disabled={!available || !createBackup || pending}
          value={destination}
          onValueChange={onDestinationChange}
        >
          <SelectTrigger
            aria-label="Backup destination"
            className="h-9 w-full bg-background"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="min-w-(--radix-select-trigger-width)">
            <SelectItem value="default">
              Default · Preferred destination
            </SelectItem>
            <SelectItem value="local">Local Relay</SelectItem>
            {availableStorage.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                S3 · {candidate.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    </div>
  )
})
