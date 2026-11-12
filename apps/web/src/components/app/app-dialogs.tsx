import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, HardDrive, LoaderCircle, Trash2 } from "lucide-react"

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

import type { App } from "@/components/app/app-presentation"
import {
  DeleteConfirmationFields,
  useDeleteConfirmation,
} from "@/components/delete-confirmation-fields"
import { useRelayPermission } from "@/components/relay/relay-settings"
import { appOwnsVolume } from "@/lib/app-volumes"
import { queryKeys, relayVolumesQueryOptions } from "@/lib/query-options"
import { deleteApp } from "@/server/apps"

export function DeleteAppDialog({
  app,
  open,
  onDeleted,
  onOpenChange,
}: {
  app: Pick<App, "id" | "name" | "relayId">
  open: boolean
  // Runs before the app lists refresh, so a page showing the app can leave
  // first.
  onDeleted?: () => void
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const confirmation = useDeleteConfirmation(app.name)
  // What an App keeps is on its volumes, which stay unless whoever may
  // delete volumes on its Relay asks for those only it uses to go with it.
  const canDeleteVolumes = useRelayPermission(app.relayId, "relay.configure")
  const volumes = useQuery({
    ...relayVolumesQueryOptions(app.relayId),
    enabled: open && canDeleteVolumes,
  })
  const ownVolumes = React.useMemo(
    () =>
      volumes.data?.protection.ready
        ? volumes.data.volumes.filter((volume) => appOwnsVolume(volume, app.id))
        : [],
    [app.id, volumes.data]
  )
  const [deleteVolumes, setDeleteVolumes] = React.useState(false)
  const volumeIds = deleteVolumes
    ? ownVolumes.flatMap((volume) => (volume.id ? [volume.id] : []))
    : []
  const remove = useMutation({
    mutationFn: () =>
      deleteApp({
        data: {
          ...confirmation.input,
          appId: app.id,
          relayId: app.relayId,
          volumeIds,
        },
      }),
    onSuccess: async () => {
      onDeleted?.()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.relayVolumes(app.relayId),
        }),
      ])
      showToast({
        description:
          volumeIds.length > 0
            ? "Its volumes are being deleted too."
            : "The volumes it used stay, with their data.",
        message: `${app.name} deleted`,
        type: "success",
      })
      onOpenChange(false)
    },
  })

  // Not while it's deleting: the request carries on either way.
  const close = (next: boolean) => {
    if (!remove.isPending) onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (confirmation.ready && !remove.isPending) remove.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete {app.name}?</DialogTitle>
            <DialogDescription>
              Its containers, networks and built images will be permanently
              removed. The volumes it uses stay, with their data: delete the
              ones you no longer want from Volumes. Schedules left with
              nothing else to run on are deleted too.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs light:bg-destructive/10">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            This action cannot be undone.
          </div>
          {ownVolumes.length > 0 ? (
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/80 bg-background/45 p-3">
              <input
                aria-label="Delete its volumes too"
                checked={deleteVolumes}
                className="mt-0.5 size-4 rounded-[3px] border-input accent-primary"
                disabled={remove.isPending}
                type="checkbox"
                onChange={(event) =>
                  setDeleteVolumes(event.currentTarget.checked)
                }
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <HardDrive className="size-4 text-muted-foreground" />
                  Delete its volumes too
                </span>
                <span className="type-meta mt-1 block text-muted-foreground">
                  {ownVolumes.map((volume) => volume.name).join(", ")}
                </span>
              </span>
            </label>
          ) : null}
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
              onClick={() => close(false)}
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
              Delete App
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
