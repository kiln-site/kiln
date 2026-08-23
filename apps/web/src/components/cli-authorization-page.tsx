import * as React from "react"
import type { CliAccessDuration, CliAccessMode } from "@workspace/contracts"
import { cliAccessDurationSchema } from "@workspace/contracts"
import {
  Check,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  Terminal,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Switch } from "@workspace/ui/components/switch"

import { HearthMark } from "@/components/hearth-mark"
import type { CliAuthorizationRequest } from "@/effect/cli-access"
import { recoverPromise } from "@/effect/promise"
import { approveCliAuthorization, denyCliAuthorization } from "@/server/cli"

type AuthorizationResult = "approved" | "denied" | null

export function CliAuthorizationPage({
  defaultAccessDays,
  request,
  requestError,
  onCodeSubmit,
}: {
  defaultAccessDays: number
  request: CliAuthorizationRequest | null
  requestError: string | null
  onCodeSubmit: (code: string) => void
}) {
  const [mode, setMode] = React.useState<CliAccessMode>("full_access")
  const [duration, setDuration] = React.useState<CliAccessDuration>("30d")
  const [pending, setPending] = React.useState<"approve" | "deny" | null>(null)
  const [result, setResult] = React.useState<AuthorizationResult>(null)
  const [error, setError] = React.useState<string | null>(null)

  if (!request) {
    return <CliCodeEntry error={requestError} onSubmit={onCodeSubmit} />
  }

  async function approve() {
    if (!request || pending) return
    setPending("approve")
    setError(null)
    const failure = await recoverPromise(
      async () => {
        await approveCliAuthorization({
          data: { duration, mode, userCode: request.userCode },
        })
        return null
      },
      (cause) => cause
    )
    setPending(null)
    if (failure) {
      setError(errorMessage(failure, "Could not link this CLI."))
      return
    }
    setResult("approved")
  }

  async function deny() {
    if (!request || pending) return
    setPending("deny")
    setError(null)
    const failure = await recoverPromise(
      async () => {
        await denyCliAuthorization({ data: { userCode: request.userCode } })
        return null
      },
      (cause) => cause
    )
    setPending(null)
    if (failure) {
      setError(errorMessage(failure, "Could not deny this request."))
      return
    }
    setResult("denied")
  }

  if (result) {
    return (
      <CliAuthorizationShell>
        <div className="border border-primary/20 bg-primary/6 p-5">
          <span className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Check className="size-5" />
          </span>
          <h1 className="mt-5 font-heading text-2xl font-semibold tracking-[-0.04em]">
            {result === "approved" ? "CLI linked" : "Request denied"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {result === "approved"
              ? `${request.name} can finish signing in. You can close this window.`
              : `${request.name} was not given access. You can close this window.`}
          </p>
        </div>
      </CliAuthorizationShell>
    )
  }

  return (
    <CliAuthorizationShell>
      <div className="flex items-start gap-4 border-b pb-5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl border bg-card shadow-sm">
          <Terminal className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="type-technical-label text-primary">
            Device authorization
          </p>
          <h1 className="mt-1 truncate font-heading text-2xl font-semibold tracking-[-0.04em]">
            Link {request.name}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            This CLI will act as your account and keep the permissions you
            already have in Hearth.
          </p>
        </div>
      </div>

      <div className="grid gap-5 py-5">
        <div className="flex items-center justify-between border bg-muted/25 px-3 py-2.5">
          <span className="type-code flex items-center gap-2 text-muted-foreground">
            <KeyRound className="size-3.5" /> Authorization code
          </span>
          <code className="text-sm font-semibold tracking-[0.18em]">
            {request.userCode}
          </code>
        </div>

        <div className="flex items-start gap-3 border p-3.5">
          <Switch
            aria-label="Read-only access"
            className="mt-0.5"
            checked={mode === "read_only"}
            onCheckedChange={(checked) => {
              const nextMode = checked ? "read_only" : "full_access"
              setMode(nextMode)
              if (!checked && duration === "indefinite") setDuration("30d")
            }}
          />
          <span>
            <span className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="size-4 text-primary" /> Read-only access
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
              Allow discovery, logs, and file reads. Block power, console, file
              writes, and uploads.
            </span>
          </span>
        </div>

        <div className="grid gap-2 text-xs font-medium">
          <span id="cli-access-duration-label">Access duration</span>
          <Select
            value={duration}
            onValueChange={(value) => {
              const parsed = cliAccessDurationSchema.safeParse(value)
              if (parsed.success) setDuration(parsed.data)
            }}
          >
            <SelectTrigger
              id="cli-access-duration"
              aria-labelledby="cli-access-duration-label"
              className="h-10 w-full [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">1 hour</SelectItem>
              <SelectItem value="1d">1 day</SelectItem>
              <SelectItem value="1w">1 week</SelectItem>
              <SelectItem value="30d">
                {defaultAccessDays} days (default)
              </SelectItem>
              <SelectItem value="indefinite" disabled={mode !== "read_only"}>
                Indefinite — read-only only
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mb-4 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2 border-t pt-4">
        <Button
          type="button"
          variant="ghost"
          disabled={pending !== null}
          onClick={() => void deny()}
        >
          {pending === "deny" ? (
            <LoaderCircle className="animate-spin" />
          ) : null}
          Deny
        </Button>
        <Button
          type="button"
          disabled={pending !== null}
          onClick={() => void approve()}
        >
          {pending === "approve" ? (
            <LoaderCircle className="animate-spin" />
          ) : null}
          Authorize CLI
        </Button>
      </div>
    </CliAuthorizationShell>
  )
}

function CliCodeEntry({
  error,
  onSubmit,
}: {
  error: string | null
  onSubmit: (code: string) => void
}) {
  const [code, setCode] = React.useState("")
  return (
    <CliAuthorizationShell>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit(code)
        }}
      >
        <Terminal className="size-6 text-primary" />
        <h1 className="mt-5 font-heading text-2xl font-semibold tracking-[-0.04em]">
          Link a CLI
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Enter the code printed by <code>kiln login</code>.
        </p>
        <Input
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          placeholder="ABCD-2345"
          autoComplete="one-time-code"
          className="mt-5 h-11 font-mono tracking-[0.18em] uppercase"
          maxLength={9}
          autoFocus
          required
        />
        {error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="mt-3 w-full" disabled={!code.trim()}>
          Continue
        </Button>
      </form>
    </CliAuthorizationShell>
  )
}

function CliAuthorizationShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-background p-5">
      <div className="pointer-events-none absolute inset-0 bg-[image:var(--ambient-grid)] [mask-image:radial-gradient(ellipse_75%_75%_at_50%_45%,black,transparent)] bg-[size:64px_64px]" />
      <section className="relative w-full max-w-lg border bg-card/92 p-5 shadow-xl backdrop-blur-sm sm:p-7">
        <HearthMark className="absolute top-4 right-4 size-7 rounded-lg opacity-75" />
        {children}
      </section>
    </main>
  )
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}
