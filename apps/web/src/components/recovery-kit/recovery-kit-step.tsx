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
import { RecoveryKitPanel } from "@/components/recovery-kit/recovery-kit-panel"
import { useAcknowledgeRecoveryKit } from "@/components/recovery-kit/use-acknowledge-recovery-kit"
import { recoveryKitStatusQueryOptions } from "@/lib/query-options"

/**
 * The step between creating Kiln's first administrator and the app: save the
 * recovery kit. Platform administrators come back to it while nobody has.
 */
export function RecoveryKitStep() {
  const { data: status } = useSuspenseQuery(recoveryKitStatusQueryOptions())
  const [revealed, setRevealed] = React.useState(false)
  const [skipping, setSkipping] = React.useState(false)
  // A full load into the app.
  const finish = React.useCallback(() => {
    window.location.assign("/")
  }, [])
  const acknowledge = useAcknowledgeRecoveryKit(finish)

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-background px-5 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[image:var(--ambient-spotlight)]" />
      <div className="pointer-events-none absolute inset-0 bg-[image:var(--ambient-grid)] bg-[size:56px_56px]" />

      <section className="relative w-full max-w-lg rounded-2xl border bg-card/80 p-6 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-8">
        <div className="flex items-center gap-2.5">
          <HearthMark />
          <span className="font-heading text-sm font-semibold">Kiln</span>
        </div>

        <div className="mt-9 grid size-10 place-items-center rounded-xl border border-primary/25 bg-primary/8 text-primary-ink">
          <KeyRound className="size-5" />
        </div>
        <h1 className="mt-5 font-heading text-2xl font-semibold tracking-[-0.04em]">
          Save your recovery kit
        </h1>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          It's the only way to restore Kiln and read your backups if this
          machine is lost. Anyone holding it can read Kiln's data, so keep it
          somewhere safe, apart from your backups.
        </p>

        <div className="mt-6">
          <RecoveryKitPanel
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
              <DialogTitle>Skip saving it for now?</DialogTitle>
              <DialogDescription>
                If this machine is lost before you save it, Kiln and its backups
                can't be restored. Kiln will remind you, and you can save it
                from Kiln → Security
                {status.firstRevealDone || revealed
                  ? ", with a two-factor code."
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
