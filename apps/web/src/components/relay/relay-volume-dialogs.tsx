import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  RELAY_VOLUME_NAME_MAX_LENGTH,
  relayVolumeSlug,
  type RelayVolume,
} from "@workspace/contracts"
import { CircleAlert, LoaderCircle, Plus, Trash2 } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

import {
  DeleteConfirmationFields,
  useDeleteConfirmation,
} from "@/components/delete-confirmation-fields"
import { FinalBackupFields } from "@/components/final-backup-fields"
import { queryKeys } from "@/lib/query-options"
import { parseVolumeSpecs } from "@/lib/volume-spec"
import {
  createRelayVolume,
  deleteRelayVolume,
  renameRelayVolume,
} from "@/server/relay-volumes"

function useRefreshVolumes(relayId: string) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.relayVolumes(relayId) })
}

// What the New volume button opens, in place: a name is all a volume needs.
export function CreateVolumeForm({
  relayId,
  onDone,
}: {
  relayId: string
  onDone: () => void
}) {
  const refresh = useRefreshVolumes(relayId)
  const [name, setName] = React.useState("")
  const trimmed = name.trim()
  const create = useMutation({
    mutationFn: () => createRelayVolume({ data: { name: trimmed, relayId } }),
    onSuccess: async (volume) => {
      await refresh()
      showToast({ message: `${volume.name} created`, type: "success" })
      onDone()
    },
  })
  return (
    <form
      className="grid gap-3 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (trimmed && !create.isPending) create.mutate()
      }}
    >
      <label className="grid gap-1.5">
        <span className="text-xs font-medium">Name</span>
        <Input
          autoFocus
          maxLength={RELAY_VOLUME_NAME_MAX_LENGTH}
          placeholder="Postgres data"
          required
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          onPaste={(event) => {
            // A line from a Compose file names its volume.
            const [first] = parseVolumeSpecs(
              event.clipboardData.getData("text")
            )
            if (first?.spec?.kind !== "volume") return
            event.preventDefault()
            setName(first.spec.name)
          }}
        />
        <span className="type-meta text-muted-foreground">
          Apps on this Relay can mount it. Docker names it{" "}
          <span className="font-mono text-foreground">
            kiln-…-{relayVolumeSlug(trimmed)}
          </span>
          , which can't change.
        </span>
      </label>
      {create.error ? (
        <p className="text-xs text-destructive">{create.error.message}</p>
      ) : null}
      <div className="flex justify-end">
        <Button disabled={create.isPending || !trimmed} size="sm" type="submit">
          {create.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Plus />
          )}
          Create volume
        </Button>
      </div>
    </form>
  )
}

export function RenameVolumeDialog({
  relayId,
  volume,
  onClose,
}: {
  relayId: string
  volume: RelayVolume
  onClose: () => void
}) {
  const refresh = useRefreshVolumes(relayId)
  const [name, setName] = React.useState(volume.name)
  const trimmed = name.trim()
  const rename = useMutation({
    mutationFn: () =>
      renameRelayVolume({
        data: { name: trimmed, relayId, volumeId: volume.id! },
      }),
    onSuccess: async () => {
      await refresh()
      showToast({ message: "Volume renamed", type: "success" })
      onClose()
    },
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !rename.isPending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (trimmed && trimmed !== volume.name && !rename.isPending) {
              rename.mutate()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename volume</DialogTitle>
            <DialogDescription>
              Docker keeps calling it{" "}
              <span className="font-mono text-foreground">
                {volume.dockerName}
              </span>
              .
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Volume name"
            autoFocus
            maxLength={RELAY_VOLUME_NAME_MAX_LENGTH}
            required
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          {rename.error ? (
            <p className="text-xs text-destructive">{rename.error.message}</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={rename.isPending || !trimmed || trimmed === volume.name}
              type="submit"
            >
              {rename.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteVolumeDialog({
  relayId,
  volume,
  onClose,
}: {
  relayId: string
  volume: RelayVolume
  onClose: () => void
}) {
  const refresh = useRefreshVolumes(relayId)
  const confirmation = useDeleteConfirmation(volume.name)
  const [createBackup, setCreateBackup] = React.useState(true)
  const [backupDestination, setBackupDestination] = React.useState("local")
  const remove = useMutation({
    mutationFn: () =>
      deleteRelayVolume({
        data: {
          ...confirmation.input,
          createBackup,
          relayId,
          volumeId: volume.id!,
          storageId: backupDestination === "local" ? null : backupDestination,
        },
      }),
    onSuccess: async () => {
      await refresh()
      showToast({
        description: createBackup
          ? "Its final backup was saved and the volume was removed."
          : "The volume and its files were removed without a final backup.",
        message: `${volume.name} deleted`,
        type: "success",
      })
      onClose()
    },
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (confirmation.ready && !remove.isPending) remove.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete {volume.name}?</DialogTitle>
            <DialogDescription>
              The volume{" "}
              <span className="font-mono text-foreground">
                {volume.dockerName}
              </span>{" "}
              and every file in it will be permanently removed.
            </DialogDescription>
          </DialogHeader>
          <FinalBackupFields
            createBackup={createBackup}
            destination={backupDestination}
            label="Back up volume before deleting"
            open
            pending={remove.isPending}
            onCreateBackupChange={setCreateBackup}
            onDestinationChange={setBackupDestination}
          />
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs light:bg-destructive/10">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            This action cannot be undone.
          </div>
          <DeleteConfirmationFields
            confirmation={confirmation}
            disabled={remove.isPending}
          />
          {remove.error ? (
            <p className="text-xs text-destructive">{remove.error.message}</p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={remove.isPending}
              type="button"
              variant="ghost"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              disabled={remove.isPending || !confirmation.ready}
              type="submit"
              variant="destructive"
            >
              {remove.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Trash2 />
              )}
              Delete volume
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
