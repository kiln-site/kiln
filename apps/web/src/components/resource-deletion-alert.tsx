import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LoaderCircle, RotateCcw, Trash2, TriangleAlert } from "lucide-react"

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
import { cn } from "@workspace/ui/lib/utils"

import {
  DeleteConfirmationFields,
  useDeleteConfirmation,
} from "@/components/delete-confirmation-fields"
import type { DeleteConfirmation } from "@/lib/delete-confirmation"
import {
  resourceDeletionQueryOptions,
  type ResourceDeletionTarget,
} from "@/lib/resource-deletion-queries"
import {
  cancelResourceDeletion,
  retryResourceDeletion,
} from "@/server/resource-deletions"

/**
 * Says on a game server's, database's, or App's page, or by a volume in its
 * Relay's list, that it's being deleted, and,
 * when its deletion stopped, why, with what its person can do: try again,
 * delete it without a final backup, or keep it. Says nothing otherwise.
 */
export const ResourceDeletionAlert = React.memo(function ResourceDeletionAlert({
  canDelete,
  kind,
  name,
  relayId,
  resourceId,
}: {
  canDelete: boolean
  kind: ResourceDeletionTarget["kind"]
  name: string
  relayId: string
  resourceId: string
}) {
  const target = { kind, relayId, resourceId }
  const options = resourceDeletionQueryOptions(target)
  const { data: deletion } = useQuery(options)
  const queryClient = useQueryClient()
  const [skipping, setSkipping] = React.useState(false)
  const refresh = () =>
    queryClient.invalidateQueries({ exact: true, queryKey: options.queryKey })
  const retry = useMutation({
    mutationFn: (
      input: { finalBackup: boolean } & Partial<DeleteConfirmation>
    ) => retryResourceDeletion({ data: { ...target, ...input } }),
    onError: (error) => showToast({ message: error.message, type: "error" }),
    onSuccess: () => {
      setSkipping(false)
      showToast({ message: `Deleting ${name} again`, type: "success" })
      return refresh()
    },
  })
  const cancel = useMutation({
    mutationFn: () => cancelResourceDeletion({ data: target }),
    onError: (error) => showToast({ message: error.message, type: "error" }),
    onSuccess: () => {
      showToast({ message: `${name} was kept`, type: "success" })
      return refresh()
    },
  })
  if (!deletion) return null
  const subject = subjects[target.kind]
  const failed = deletion.status === "failed"
  const busy = retry.isPending || cancel.isPending
  return (
    <section
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3",
        failed
          ? "border-red-500/30 bg-red-500/8 light:bg-red-500/6"
          : "border-orange-500/30 bg-orange-500/8 light:bg-orange-500/6"
      )}
    >
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-lg border",
          failed
            ? "border-red-500/35 text-red-300 light:text-red-700"
            : "border-orange-500/35 text-orange-300 light:text-orange-700"
        )}
      >
        {failed ? (
          <TriangleAlert className="size-4" />
        ) : (
          <LoaderCircle className="size-4 animate-spin" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="type-card-title">
          {failed
            ? `Deleting this ${subject} stopped`
            : deletion.status === "cancelling"
              ? `Keeping this ${subject}`
              : `This ${subject} is being deleted`}
        </p>
        <p className="type-meta mt-0.5 text-muted-foreground">
          {failed
            ? deletion.deletedOnRelay
              ? `Its Relay deleted it, but cleaning up after it didn't finish: ${sentence(deletion.error ?? "an unknown error")}`
              : deletion.deletionStarted
                ? `Its Relay began deleting it, but didn't finish: ${sentence(deletion.error ?? "an unknown error")} It can only be finished now. Final backups already taken stay.`
                : `${sentence(deletion.error ?? "It stopped for an unknown reason")} Until it's deleted or kept, it can't be changed${target.kind === "database" ? ", though game servers and Apps connected to it can still write to it. Trying again takes a new final backup" : ""}.`
            : deletion.status === "cancelling"
              ? "Kiln is letting it go on its Relay. It can be changed again once that finishes."
              : target.kind === "database"
                ? deletion.status === "backing_up"
                  ? "Its final backup is running. Game servers and Apps connected to it can still write to it, but what they write after the backup started isn't in it."
                  : "Kiln can't change it meanwhile, though game servers and Apps connected to it can still write to it."
                : deletion.status === "backing_up"
                  ? target.kind === "app"
                    ? "Its final backups are running: its folder, then each volume only it uses. Nothing can change it meanwhile."
                    : "Its final backup is running. Nothing can change it meanwhile."
                  : "Nothing can change it meanwhile."}
        </p>
        {failed && canDelete ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              disabled={busy}
              size="sm"
              variant="outline"
              onClick={() =>
                retry.mutate({
                  finalBackup: deletion.deletionStarted
                    ? false
                    : deletion.finalBackup,
                })
              }
            >
              {retry.isPending && !skipping ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <RotateCcw />
              )}
              {deletion.deletionStarted ? "Finish deletion" : "Try again"}
            </Button>
            {deletion.deletionStarted ? null : (
              <>
                {deletion.finalBackup ? (
                  <Button
                    disabled={busy}
                    size="sm"
                    variant="outline"
                    onClick={() => setSkipping(true)}
                  >
                    <Trash2 />
                    Delete without a final backup
                  </Button>
                ) : null}
                <Button
                  disabled={busy}
                  size="sm"
                  variant="outline"
                  onClick={() => cancel.mutate()}
                >
                  {cancel.isPending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : null}
                  Keep it
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>
      {skipping ? (
        <SkipFinalBackupDialog
          name={name}
          pending={retry.isPending}
          subject={subject}
          onConfirm={(confirmation) =>
            retry.mutate({ ...confirmation, finalBackup: false })
          }
          onOpenChange={(open) => {
            if (!open && !retry.isPending) setSkipping(false)
          }}
        />
      ) : null}
    </section>
  )
})

const subjects: Record<ResourceDeletionTarget["kind"], string> = {
  app: "App",
  database: "database",
  instance: "game server",
  volume: "volume",
}

function SkipFinalBackupDialog({
  name,
  onConfirm,
  onOpenChange,
  pending,
  subject,
}: {
  name: string
  onConfirm: (confirmation: DeleteConfirmation) => void
  onOpenChange: (open: boolean) => void
  pending: boolean
  subject: string
}) {
  const confirmation = useDeleteConfirmation(name)
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (pending || !confirmation.ready) return
            onConfirm(confirmation.input)
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete {name} without a final backup?</DialogTitle>
            <DialogDescription>
              Without a final backup, this {subject} and its data are gone for
              good. Backups made before stay.
              {subject === "game server" || subject === "database"
                ? " Schedules left with nothing else to run on are deleted too."
                : null}
            </DialogDescription>
          </DialogHeader>
          <DeleteConfirmationFields
            confirmation={confirmation}
            disabled={pending}
          />
          <DialogFooter>
            <Button
              disabled={pending}
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={pending || !confirmation.ready}
              type="submit"
              variant="destructive"
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              Delete without a final backup
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function sentence(text: string): string {
  return /[.!?]$/u.test(text) ? text : `${text}.`
}
