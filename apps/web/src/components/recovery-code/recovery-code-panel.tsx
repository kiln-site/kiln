import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { LoaderCircle, ShieldAlert } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"

import { RecoveryCodeSaveOptions } from "@/components/recovery-code/recovery-code-save-options"
import { recoverPromise } from "@/effect/promise"
import { queryKeys } from "@/lib/query-options"
import type {
  RecoveryCodeReveal,
  RecoveryCodeStatus,
} from "@/lib/recovery-code"
import { revealRecoveryCode } from "@/server/recovery-code"

/**
 * Shows Kiln's recovery code and the ways to save it: right away, masked,
 * while it needs nothing more, or after a fresh two-factor code. The code
 * lives only in this component's state, gone when it unmounts.
 */
export function RecoveryCodePanel({
  onRevealed,
  status,
}: {
  onRevealed?: () => void
  status: RecoveryCodeStatus
}) {
  const queryClient = useQueryClient()
  const [reveal, setReveal] = React.useState<RecoveryCodeReveal | null>(null)
  const [twoFactorCode, setTwoFactorCode] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const { needsTwoFactor } = status
  const unavailable = status.available === "none"

  const show = React.useCallback(
    async (entered: string | null) => {
      setPending(true)
      setError(null)
      const result = await recoverPromise(
        async () => ({
          reveal: await revealRecoveryCode({
            data: { twoFactorCode: entered },
          }),
        }),
        (cause) => ({
          error:
            cause instanceof Error
              ? cause.message
              : "The recovery code couldn't be shown",
        })
      )
      setPending(false)
      setTwoFactorCode("")
      // Whether it asks for a code may have changed.
      void queryClient.invalidateQueries({ queryKey: queryKeys.recoveryCode })
      if ("error" in result) {
        setError(result.error)
        return
      }
      setReveal(result.reveal)
      onRevealed?.()
    },
    [onRevealed, queryClient]
  )

  // Once per mount, even when development mounts it twice.
  const started = React.useRef(false)
  React.useEffect(() => {
    if (started.current || needsTwoFactor || unavailable) return
    started.current = true
    void show(null)
  }, [needsTwoFactor, show, unavailable])

  if (reveal) return <RecoveryCodeSaveOptions reveal={reveal} />

  if (unavailable) {
    return (
      <p className="type-meta rounded-lg border border-border/80 px-3 py-2.5 text-muted-foreground">
        Kiln's recovery code is on the Relay beside Hearth, which isn't
        connected.
      </p>
    )
  }

  if (needsTwoFactor && !status.twoFactorEnabled) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-amber-400/30 bg-amber-400/8 px-3 py-3 light:bg-amber-400/16">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-300 light:text-amber-700" />
        <div className="grid gap-2">
          <p className="type-meta">
            Turn on two-factor authentication to see the code.
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

  const alert = error ? (
    <p
      role="alert"
      className="type-meta rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-red-300 light:bg-destructive/16 light:text-red-700"
    >
      {error}
    </p>
  ) : null

  if (!needsTwoFactor) {
    return (
      <div className="grid gap-3">
        {alert}
        {pending || !error ? (
          <div className="grid h-20 place-items-center">
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            onClick={() => void show(null)}
          >
            Try again
          </Button>
        )}
      </div>
    )
  }

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void show(twoFactorCode)
      }}
    >
      <label className="grid gap-1.5" htmlFor="recovery-code-two-factor">
        <span className="type-control-sm">Two-factor code</span>
        <div className="flex gap-2">
          <Input
            id="recovery-code-two-factor"
            value={twoFactorCode}
            onChange={(event) => setTwoFactorCode(event.target.value)}
            autoComplete="one-time-code"
            inputMode="text"
            placeholder="123456 or a backup code"
            required
            autoFocus
            className="h-9 min-w-0 flex-1 font-mono"
          />
          <Button type="submit" disabled={pending}>
            {pending ? <LoaderCircle className="animate-spin" /> : null}
            Show
          </Button>
        </div>
      </label>
      {alert}
    </form>
  )
}
