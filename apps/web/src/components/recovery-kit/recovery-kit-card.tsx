import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { KeyRound, ShieldCheck } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { RelativeTime } from "@/components/relative-time"
import { recoveryKitStatusQueryOptions } from "@/lib/query-options"

const RecoveryKitDialog = React.lazy(async () => ({
  default: (await import("@/components/recovery-kit/recovery-kit-dialog"))
    .RecoveryKitDialog,
}))

/** Kiln → Security's recovery kit: whether it's saved, and a way to save it. */
export const RecoveryKitCard = React.memo(function RecoveryKitCard() {
  const { data: status } = useQuery(recoveryKitStatusQueryOptions())
  const [open, setOpen] = React.useState(false)
  const close = React.useCallback(() => setOpen(false), [])
  if (!status) return null
  const saved = status.saved
  return (
    <section
      id="recovery-kit"
      aria-label="Recovery kit"
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-3 rounded-xl border px-4 py-3",
        saved
          ? "border-border/80"
          : "border-amber-400/30 bg-amber-400/8 light:bg-amber-400/16"
      )}
    >
      {saved ? (
        <ShieldCheck className="size-5 shrink-0 text-muted-foreground" />
      ) : (
        <KeyRound className="size-5 shrink-0 text-amber-300 light:text-amber-700" />
      )}
      <div className="min-w-0 flex-1">
        <p className="type-card-title">Recovery kit</p>
        <p className="type-meta text-muted-foreground">
          {saved ? (
            <>
              Saved <RelativeTime timestamp={saved.at} />
              {saved.by ? ` by ${saved.by}` : ""}
            </>
          ) : (
            "Not saved yet. Without it, a lost machine can't be restored."
          )}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant={saved ? "outline" : "default"}
        onClick={() => setOpen(true)}
      >
        Save recovery kit…
      </Button>
      {open ? (
        <React.Suspense fallback={null}>
          <RecoveryKitDialog status={status} onClose={close} />
        </React.Suspense>
      ) : null}
    </section>
  )
})
