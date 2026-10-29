import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, LoaderCircle, Trash2 } from "lucide-react"

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
import { queryKeys } from "@/lib/query-options"
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
  const remove = useMutation({
    mutationFn: () =>
      deleteApp({
        data: {
          ...confirmation.input,
          appId: app.id,
          relayId: app.relayId,
        },
      }),
    onSuccess: async () => {
      onDeleted?.()
      await queryClient.invalidateQueries({ queryKey: queryKeys.apps.all })
      showToast({ message: `${app.name} deleted`, type: "success" })
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
              Its containers, networks, built images, Compose volumes, and data
              directory will be permanently removed.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs light:bg-destructive/10">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            This action cannot be undone. Download anything you need from its
            files first.
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
              Delete app
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
