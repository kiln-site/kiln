import * as React from "react"
import { useSuspenseQuery } from "@tanstack/react-query"
import { Check, KeyRound, LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"

import { HearthMark } from "@/components/hearth-mark"
import { RecoveryCodePanel } from "@/components/recovery-code/recovery-code-panel"
import { useAcknowledgeRecoveryCode } from "@/components/recovery-code/use-acknowledge-recovery-code"
import { recoveryCodeStatusQueryOptions } from "@/lib/query-options"
import { recoveryCodePurpose } from "@/lib/recovery-code"

/**
 * The step between creating Kiln's first administrator and the app: save the
 * recovery code. Platform administrators come back to it while nobody has.
 */
export function RecoveryCodeStep() {
  const { data: status } = useSuspenseQuery(recoveryCodeStatusQueryOptions())
  const [revealed, setRevealed] = React.useState(false)
  const [skipping, setSkipping] = React.useState(false)
  // A full load into the app.
  const finish = React.useCallback(() => {
    window.location.assign("/")
  }, [])
  const acknowledge = useAcknowledgeRecoveryCode(finish)

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-background px-5 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[image:var(--ambient-spotlight)]" />
      <div className="pointer-events-none absolute inset-0 bg-[image:var(--ambient-grid)] bg-[size:56px_56px]" />

      <section className="relative w-full max-w-lg rounded-2xl border bg-card/80 p-6 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <HearthMark />
            <span className="font-heading text-sm font-semibold">Kiln</span>
          </div>
          <div className="grid size-10 place-items-center rounded-xl border border-primary/25 bg-primary/8 text-primary-ink">
            <KeyRound className="size-5" />
          </div>
        </div>

        <h1 className="mt-9 font-heading text-2xl font-semibold tracking-[-0.04em]">
          Save your recovery code
        </h1>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {recoveryCodePurpose}
        </p>

        <div className="mt-6">
          <RecoveryCodePanel
            status={status}
            onRevealed={() => setRevealed(true)}
          />
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setSkipping(true)}
          >
            Remind me later
          </Button>
          <Button
            type="button"
            disabled={!revealed || acknowledge.isPending}
            onClick={() => acknowledge.mutate()}
          >
            {acknowledge.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Check />
            )}
            I've saved it
          </Button>
        </div>
      </section>

      {skipping ? (
        <Dialog open onOpenChange={(open) => !open && setSkipping(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Skip for now?</DialogTitle>
              <DialogDescription>
                Without the code, you can't restore Kiln on a new machine. You
                can save it later from Kiln → Security
                {status.needsTwoFactor || revealed
                  ? " with a two-factor code."
                  : "."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setSkipping(false)}
              >
                Go back
              </Button>
              <Button type="button" variant="destructive" onClick={finish}>
                Remind me later
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </main>
  )
}
