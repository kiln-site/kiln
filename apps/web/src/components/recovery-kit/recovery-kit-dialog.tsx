import * as React from "react"
import { Check, LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"

import { RecoveryKitPanel } from "@/components/recovery-kit/recovery-kit-panel"
import { useAcknowledgeRecoveryKit } from "@/components/recovery-kit/use-acknowledge-recovery-kit"
import type { RecoveryKitStatus } from "@/lib/recovery-kit"

/**
 * Kiln → Security's way to save the recovery kit. Mounted only while open,
 * so the kit it shows is gone once it closes.
 */
export function RecoveryKitDialog({
  onClose,
  status,
}: {
  onClose: () => void
  status: RecoveryKitStatus
}) {
  const [revealed, setRevealed] = React.useState(false)
  const acknowledge = useAcknowledgeRecoveryKit(onClose)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Save Kiln's recovery kit</DialogTitle>
          <DialogDescription>
            It's the only way to restore Kiln and read its backups if this
            machine is lost. Anyone holding it can read Kiln's data, so keep it
            somewhere safe, apart from your backups.
          </DialogDescription>
        </DialogHeader>
        <RecoveryKitPanel
          status={status}
          onRevealed={() => setRevealed(true)}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {revealed ? "Close" : "Cancel"}
          </Button>
          {revealed ? (
            <Button
              type="button"
              disabled={acknowledge.isPending}
              onClick={() => acknowledge.mutate()}
            >
              {acknowledge.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Check />
              )}
              I've saved it
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
