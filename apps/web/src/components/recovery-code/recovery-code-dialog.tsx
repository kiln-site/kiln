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

import { RecoveryCodePanel } from "@/components/recovery-code/recovery-code-panel"
import { useAcknowledgeRecoveryCode } from "@/components/recovery-code/use-acknowledge-recovery-code"
import {
  recoveryCodePurpose,
  type RecoveryCodeStatus,
} from "@/lib/recovery-code"

/**
 * Kiln → Security's way to save the recovery code. Mounted only while open,
 * so the code it shows is gone once it closes.
 */
export function RecoveryCodeDialog({
  onClose,
  status,
}: {
  onClose: () => void
  status: RecoveryCodeStatus
}) {
  const [revealed, setRevealed] = React.useState(false)
  const acknowledge = useAcknowledgeRecoveryCode(onClose)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Save your recovery code</DialogTitle>
          <DialogDescription>{recoveryCodePurpose}</DialogDescription>
        </DialogHeader>
        <RecoveryCodePanel
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
