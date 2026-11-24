import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { KeyRound, ShieldCheck } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { RelativeTime } from "@/components/relative-time"
import { recoveryCodeStatusQueryOptions } from "@/lib/query-options"

const RecoveryCodeDialog = React.lazy(async () => ({
  default: (await import("@/components/recovery-code/recovery-code-dialog"))
    .RecoveryCodeDialog,
}))

/**
 * Kiln → Security's recovery code: whether it's saved, whether a backup it
 * restores is kept away from this machine, and a way to save it. Its dialog
 * is open while the page's address says so.
 */
export const RecoveryCodeCard = React.memo(function RecoveryCodeCard({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const { data: status } = useQuery(recoveryCodeStatusQueryOptions())
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange])
  if (!status) return null
  const { recoverableBackup, saved } = status
  const ready = saved !== null && recoverableBackup !== null
  return (
    <section
      id="recovery-code"
      aria-label="Recovery code"
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-3 rounded-xl border px-4 py-3",
        ready
          ? "border-border/80"
          : "border-amber-400/30 bg-amber-400/8 light:bg-amber-400/16"
      )}
    >
      {ready ? (
        <ShieldCheck className="size-5 shrink-0 text-muted-foreground" />
      ) : (
        <KeyRound className="size-5 shrink-0 text-amber-300 light:text-amber-700" />
      )}
      <div className="min-w-0 flex-1">
        <p className="type-card-title">Recovery code</p>
        <p className="type-meta text-muted-foreground">
          {saved ? (
            <>
              Saved <RelativeTime timestamp={saved.at} />
              {saved.by ? ` by ${saved.by}` : ""}
            </>
          ) : (
            "Not saved yet"
          )}
          {" · "}
          {recoverableBackup ? (
            <>
              Backed up off this machine{" "}
              <RelativeTime timestamp={recoverableBackup.at} />
            </>
          ) : (
            <Link
              to="/backups/destinations"
              className="underline underline-offset-2 hover:text-foreground"
            >
              No backup off this machine yet
            </Link>
          )}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant={saved ? "outline" : "default"}
        onClick={() => onOpenChange(true)}
      >
        {saved ? "Show" : "Save"}
      </Button>
      {open ? (
        <React.Suspense fallback={null}>
          <RecoveryCodeDialog status={status} onClose={close} />
        </React.Suspense>
      ) : null}
    </section>
  )
})
