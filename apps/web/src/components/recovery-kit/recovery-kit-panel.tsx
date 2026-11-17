import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { KeyRound, LoaderCircle, ShieldAlert } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"

import { RecoveryKitSaveOptions } from "@/components/recovery-kit/recovery-kit-save-options"
import { recoverPromise } from "@/effect/promise"
import type { FirstLaunchLogin } from "@/lib/first-launch-login"
import { queryKeys } from "@/lib/query-options"
import type { RecoveryKitReveal, RecoveryKitStatus } from "@/lib/recovery-kit"
import { revealRecoveryKit } from "@/server/recovery-kit"

/**
 * Shows Kiln's recovery kit and the ways to save it. The first time it's
 * ever shown it needs nothing more; after that, a fresh two-factor code.
 * The kit lives only in this component's state, gone when it unmounts.
 */
export function RecoveryKitPanel({
  login = null,
  onRevealed,
  status,
}: {
  login?: FirstLaunchLogin | null
  onRevealed?: () => void
  status: RecoveryKitStatus
}) {
  const queryClient = useQueryClient()
  const [reveal, setReveal] = React.useState<RecoveryKitReveal | null>(null)
  const [code, setCode] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const needsCode = status.firstRevealDone

  async function show(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    const result = await recoverPromise(
      async () => ({
        reveal: await revealRecoveryKit({
          data: { code: needsCode ? code : null },
        }),
      }),
      (cause) => ({
        error:
          cause instanceof Error
            ? cause.message
            : "Kiln's recovery kit couldn't be shown",
      })
    )
    setPending(false)
    setCode("")
    // Every reveal after the first asks for a code, and someone else may
    // have taken the first meanwhile.
    if (!needsCode) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recoveryKit })
    }
    if ("error" in result) {
      setError(result.error)
      return
    }
    setReveal(result.reveal)
    onRevealed?.()
  }

  if (reveal) return <RecoveryKitSaveOptions login={login} reveal={reveal} />

  if (status.available === "none") {
    return (
      <p className="type-meta rounded-lg border border-border/80 px-3 py-2.5 text-muted-foreground">
        No connected Relay holds Kiln's recovery kit. The Relay that installed
        Kiln has it; a Kiln set up another way needs KILN_PLATFORM_BACKUP_KEY on
        the Relay beside it.
      </p>
    )
  }

  if (needsCode && !status.twoFactorEnabled) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-amber-400/30 bg-amber-400/8 px-3 py-3 light:bg-amber-400/16">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-300 light:text-amber-700" />
        <div className="grid gap-2">
          <p className="type-meta">
            Showing the recovery kit again takes a code from an authenticator
            app. Turn on two-factor authentication first.
          </p>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="justify-self-start"
          >
            <Link to="/settings/account">Account settings</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form className="grid gap-3" onSubmit={(event) => void show(event)}>
      {needsCode ? (
        <label className="grid gap-1.5" htmlFor="recovery-kit-code">
          <span className="type-control-sm">Two-factor code</span>
          <Input
            id="recovery-kit-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="one-time-code"
            inputMode="text"
            placeholder="123456 or a backup code"
            required
            autoFocus
            className="h-9 font-mono"
          />
          <span className="type-meta text-muted-foreground">
            From your authenticator app, or one of your backup codes.
          </span>
        </label>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="type-meta rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-red-300 light:bg-destructive/16 light:text-red-700"
        >
          {error}
        </p>
      ) : null}
      <Button type="submit" className="justify-self-start" disabled={pending}>
        {pending ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
        Show recovery kit
      </Button>
    </form>
  )
}
