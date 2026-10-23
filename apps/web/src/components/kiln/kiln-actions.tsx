import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { LoaderCircle, RotateCw, Wrench } from "lucide-react"

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
import type { RelayPlatformTarget } from "@workspace/contracts"

import { InfraSyncButton } from "@/components/infra-sync-button"
import { kilnCopy } from "@/components/kiln/kiln-presentation"
import { messageFrom } from "@/components/relay/relay-actions"
import { queryKeys } from "@/lib/query-options"
import { runKilnPlatformAction } from "@/server/platform"

export function KilnRefreshButton() {
  const queryClient = useQueryClient()
  return (
    <InfraSyncButton
      label="Refresh Kiln's services"
      sync={() =>
        queryClient.invalidateQueries({ queryKey: queryKeys.kilnPlatform.all })
      }
    />
  )
}

// Recreates whatever is missing and starts whatever stopped.
export function KilnRepairButton({ relayId }: { relayId: string }) {
  const queryClient = useQueryClient()
  const repair = useMutation({
    mutationFn: () =>
      runKilnPlatformAction({ data: { action: "repair", relayId } }),
    onError: (cause) =>
      showToast({
        type: "error",
        message: messageFrom(cause, "Couldn't repair Kiln's services."),
      }),
    onSuccess: (status) => {
      showToast({
        type: status.issue ? "info" : "success",
        message: status.issue ?? "Kiln's services are running",
      })
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.kilnPlatform.all }),
  })
  return (
    <Button
      disabled={repair.isPending}
      size="sm"
      type="button"
      variant="outline"
      onClick={() => repair.mutate()}
    >
      {repair.isPending ? (
        <LoaderCircle className="animate-spin" />
      ) : (
        <Wrench />
      )}
      Repair
    </Button>
  )
}

export function KilnRestartButton({
  relayId,
  target,
}: {
  relayId: string
  target: RelayPlatformTarget
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        size="sm"
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <RotateCw /> Restart
      </Button>
      {open ? (
        <RestartDialog
          relayId={relayId}
          target={target}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

// Mounted only while open.
function RestartDialog({
  relayId,
  target,
  onClose,
}: {
  relayId: string
  target: RelayPlatformTarget
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const copy = kilnCopy[target]
  const restart = useMutation({
    mutationFn: () =>
      runKilnPlatformAction({
        data: { action: "restart", relayId, role: target },
      }),
    onSuccess: () => {
      onClose()
      showToast({
        type: "info",
        message: `Restarting ${copy.noun}`,
        duration: 4_000,
      })
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.kilnPlatform.all }),
  })
  const pending = restart.isPending
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Restart {copy.noun}?</DialogTitle>
          <DialogDescription>{copy.restart}</DialogDescription>
        </DialogHeader>
        {restart.error ? (
          <p role="alert" className="type-meta text-destructive">
            {messageFrom(restart.error, `Couldn't restart ${copy.noun}.`)}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={pending}
            type="button"
            variant="ghost"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            disabled={pending}
            type="button"
            onClick={() => restart.mutate()}
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
            Restart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
