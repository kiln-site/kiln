import { LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"

import { useRestoreKiln } from "@/components/kiln/use-restore-kiln"
import type { BackupRun } from "@/lib/backup-runs"

// Hearth can't replace its own database while it serves from it, so its Relay
// does, with Hearth stopped. See docs/self-hosting.md#recovery.
export function KilnRestoreDialog({
  backup,
  onOpenChange,
  open,
}: {
  backup: BackupRun
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const { error, restore, restoring } = useRestoreKiln()
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!restoring) onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Restore Kiln</DialogTitle>
          <DialogDescription>
            Kiln goes back to “{backup.name}”. It&apos;s down for about a
            minute, then everyone signs in again. Game servers, Apps, and
            databases keep running.
          </DialogDescription>
        </DialogHeader>
        <p className="type-meta text-muted-foreground">
          {restoring
            ? "Restoring. This page opens Kiln again once it's back."
            : "What's here now is saved first, so you can undo this from Kiln's Info page."}
        </p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button
            disabled={restoring}
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={restoring}
            type="button"
            variant="destructive"
            onClick={() =>
              restore({ backupId: backup.id, relayId: backup.relayId })
            }
          >
            {restoring ? <LoaderCircle className="animate-spin" /> : null}
            Restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
