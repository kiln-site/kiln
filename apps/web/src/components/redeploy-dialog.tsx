import * as React from "react"
import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"

// Asks before an instance is deployed again as it is set up: its image
// pulled anew and its container replaced. Each kind says what that means
// for it.
export const RedeployDialog = React.memo(function RedeployDialog({
  children,
  error,
  name,
  open,
  pending,
  onConfirm,
  onOpenChange,
}: {
  /** What a redeploy does to this kind of instance. */
  children: React.ReactNode
  error: string | null
  name: string
  open: boolean
  pending: boolean
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) return
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Redeploy {name}</DialogTitle>
          <DialogDescription>{children}</DialogDescription>
        </DialogHeader>
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive light:bg-destructive/16"
          >
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            {error}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={pending} onClick={onConfirm}>
            {pending ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            {pending ? "Redeploying…" : "Redeploy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})
