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

import { queryKeys } from "@/lib/query-options"
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

export function CreateVolumeDialog({
  relayId,
  onClose,
  onCreated,
}: {
  relayId: string
  onClose: () => void
  // Such as choosing it for what asked for it.
  onCreated?: (volume: RelayVolume) => void
}) {
  const refresh = useRefreshVolumes(relayId)
  const [name, setName] = React.useState("")
  const trimmed = name.trim()
  const create = useMutation({
    mutationFn: () => createRelayVolume({ data: { name: trimmed, relayId } }),
    onSuccess: async (volume) => {
      await refresh()
      showToast({ message: `${volume.name} created`, type: "success" })
      onCreated?.(volume)
      onClose()
    },
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (trimmed && !create.isPending) create.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>New volume</DialogTitle>
            <DialogDescription>
              A Docker named volume on this Relay. Apps can mount it to keep
              data across deployments, and share it with each other.
            </DialogDescription>
          </DialogHeader>
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Name</span>
            <Input
              autoFocus
              maxLength={RELAY_VOLUME_NAME_MAX_LENGTH}
              placeholder="Postgres data"
              required
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <span className="type-meta mt-2 block text-muted-foreground">
              Docker names it{" "}
              <span className="font-mono text-foreground">
                kiln-…-{relayVolumeSlug(trimmed)}
              </span>
              , which can't change; renaming changes only how Kiln shows it.
            </span>
          </label>
          {create.error ? (
            <p className="text-xs text-destructive">{create.error.message}</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={create.isPending || !trimmed} type="submit">
              {create.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Plus />
              )}
              Create volume
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  const remove = useMutation({
    mutationFn: () =>
      deleteRelayVolume({ data: { relayId, volumeId: volume.id! } }),
    onSuccess: async () => {
      await refresh()
      showToast({ message: `${volume.name} deleted`, type: "success" })
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
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          This action cannot be undone.
        </div>
        {remove.error ? (
          <p className="text-xs text-destructive">{remove.error.message}</p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={remove.isPending}
            type="button"
            variant="destructive"
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Trash2 />
            )}
            Delete volume
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
