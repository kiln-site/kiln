import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Effect } from "effect"
import {
  ArrowRight,
  Check,
  Clock3,
  LoaderCircle,
  LogOut,
  Server,
  ShieldCheck,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"

import { HearthMark } from "@/components/hearth-mark"
import { RelayKindIcon } from "@/components/instance-kind-icon"
import { clearAppearanceCache } from "@/lib/appearance"
import { authClient } from "@/lib/auth-client"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { DISPLAY_NAME_MAX_LENGTH } from "@/lib/display-name"
import {
  invitationReferencePath,
  type InvitationReference,
} from "@/lib/invitation-auth"
import { queryKeys } from "@/lib/query-options"
import type { getInvitationPreview } from "@/server/access"
import { acceptAccessInvitation } from "@/server/access"
import { disableDevelopmentBypass } from "@/server/auth"
import { decideResourceInvitation } from "@/server/resource-access"
import { claimInvitedAccount } from "@/server/users"

type InvitationPreview = NonNullable<
  Awaited<ReturnType<typeof getInvitationPreview>>
>

export function InvitationPage({
  preview,
  reference,
  user,
}: {
  preview: InvitationPreview | null
  reference: InvitationReference | null
  user: AuthenticatedUser | null
}) {
  const queryClient = useQueryClient()
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [accepted, setAccepted] = React.useState(false)
  const invitePath = reference ? invitationReferencePath(reference) : "/invite"
  const destination = preview?.returnPath ?? "/"
  const platformInvitation = preview?.accessType !== "scoped"
  const invitationLabel = preview
    ? preview.accessType === "platform_admin"
      ? "Platform Admin"
      : preview.accessType === "relay_creator"
        ? "Bring Your Own Relays"
        : (preview.role ?? "Scoped Access")
    : "Access"

  const acceptInvitation = Effect.tryPromise({
    try: async () => {
      if (!reference) throw new Error("Invitation not found")
      await ("token" in reference
        ? acceptAccessInvitation({ data: { token: reference.token } })
        : decideResourceInvitation({
            data: { id: reference.id, decision: "accept", force: false },
          }))
      await queryClient.invalidateQueries({
        queryKey: queryKeys.access.capabilities,
      })
    },
    catch: (cause) => cause,
  })

  const opened = Effect.sync(() => {
    setAccepted(true)
    window.setTimeout(() => window.location.assign(destination), 700)
  })

  const failed = (fallback: string) => (cause: unknown) =>
    Effect.sync(() => {
      setError(cause instanceof Error ? cause.message : fallback)
      setPending(false)
    })

  async function accept() {
    setPending(true)
    setError(null)
    await Effect.runPromise(
      acceptInvitation.pipe(
        Effect.andThen(opened),
        Effect.catch(failed("Could not accept invitation"))
      )
    )
  }

  // Sets up the invited account, signs in, and accepts, in one step. The link
  // itself authorizes the setup, so no second email is needed.
  async function createAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || !reference) return
    const form = new FormData(event.currentTarget)
    const password = String(form.get("password") ?? "")
    if (password !== form.get("confirmation")) {
      setError("The passwords do not match")
      return
    }
    setPending(true)
    setError(null)
    await Effect.runPromise(
      Effect.gen(function* () {
        const { email } = yield* Effect.tryPromise({
          try: () =>
            claimInvitedAccount({
              data: {
                invitation: reference,
                password,
                displayName: String(form.get("name") ?? ""),
              },
            }),
          catch: (cause) => cause,
        })
        // The account exists now, so any trouble signing in goes to sign-in.
        const signedIn = yield* Effect.tryPromise(() =>
          authClient.signIn.email({ email, password })
        ).pipe(Effect.catch(() => Effect.succeed(null)))
        if (!signedIn || signedIn.error) {
          window.location.assign(
            `/?email=${encodeURIComponent(email)}&redirect=${encodeURIComponent(invitePath)}`
          )
          return
        }
        // The account is ready either way; if accepting fails, the
        // invitation is still there to accept once signed in.
        yield* acceptInvitation.pipe(
          Effect.andThen(opened),
          Effect.catch(() =>
            Effect.sync(() => window.location.assign(invitePath))
          )
        )
      }).pipe(Effect.catch(failed("Could not create your account")))
    )
  }

  async function signOut() {
    if (user?.isDevelopmentBypass) await disableDevelopmentBypass()
    else await authClient.signOut()
    clearAppearanceCache()
    window.location.assign(invitePath)
  }

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-background px-6 py-12">
      <div className="pointer-events-none absolute inset-0 bg-[image:var(--ambient-grid)] [mask-image:radial-gradient(ellipse_70%_70%_at_50%_40%,black,transparent)] bg-[size:64px_64px]" />
      <section className="relative w-full max-w-md rounded-2xl border border-border/70 bg-card/45 p-6 shadow-2xl shadow-black/20 backdrop-blur-sm sm:p-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5 font-heading text-sm font-semibold">
            <HearthMark className="size-8" /> Kiln
          </div>
          {preview ? (
            <span className="type-technical-label flex items-center gap-1.5 border px-2.5 py-1 text-muted-foreground">
              <Clock3 className="size-3" /> 7-day invite
            </span>
          ) : null}
        </div>

        {!preview ? (
          <div className="py-12 text-center">
            <ShieldCheck className="mx-auto size-7 text-muted-foreground" />
            <h1 className="mt-5 font-heading text-2xl font-semibold tracking-[-0.04em]">
              Invitation unavailable
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              This invitation is invalid, has expired, was revoked, or has
              already been used.
            </p>
            <Button className="mt-6" variant="outline" asChild>
              <Link to="/">Return to Kiln</Link>
            </Button>
          </div>
        ) : accepted ? (
          <div className="py-12 text-center">
            <div className="mx-auto grid size-12 place-items-center bg-emerald-500/12 text-emerald-400 light:bg-emerald-500/24 light:text-emerald-700">
              <Check className="size-5" />
            </div>
            <h1 className="mt-5 font-heading text-2xl font-semibold tracking-[-0.04em]">
              Access granted
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Opening your control plane…
            </p>
          </div>
        ) : (
          <>
            <div className="mt-10">
              <p className="type-technical-label text-primary-ink">
                Access request
              </p>
              <h1 className="mt-2 font-heading text-3xl font-semibold tracking-[-0.05em]">
                {preview.accessType === "platform_admin"
                  ? "Administer Kiln"
                  : preview.accessType === "relay_creator"
                    ? "Bring Your Own Relays"
                    : `Join ${preview.relayName}`}
              </h1>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {preview.accessType === "platform_admin"
                  ? "You’ve been invited to manage Hearth and every connected Relay."
                  : preview.accessType === "relay_creator"
                    ? "You’ve been invited to create and manage your own Relays, including Relay updates. Hearth updates stay restricted."
                    : `You’ve been invited as ${preview.role ?? "a user"}${
                        preview.instanceId || preview.databaseId
                          ? " on one managed instance."
                          : " across this Relay."
                      }`}
              </p>
            </div>

            <div className="mt-6 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl border bg-background/60 p-4">
              {preview.accessType === "relay_creator" ? (
                <RelayKindIcon className="mt-0.5 size-4" />
              ) : platformInvitation ? (
                <ShieldCheck className="mt-0.5 size-4 text-primary-ink" />
              ) : (
                <Server className="mt-0.5 size-4 text-primary-ink" />
              )}
              <span className="text-xs font-medium">{preview.relayName}</span>
              <span />
              <span className="type-code text-muted-foreground">
                {platformInvitation
                  ? invitationLabel
                  : `${
                      preview.databaseId
                        ? `Database · ${preview.databaseId}`
                        : preview.instanceId
                          ? `Instance · ${preview.instanceId}`
                          : "Entire Relay"
                    } · ${invitationLabel}`}
              </span>
            </div>

            {error ? (
              <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive light:bg-destructive/16">
                {error}
              </p>
            ) : null}

            {user ? (
              user.id === preview.subjectId ? (
                <Button
                  className="mt-6 h-11 w-full"
                  disabled={pending}
                  onClick={() => void accept()}
                >
                  {pending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <ShieldCheck />
                  )}
                  Accept invitation
                </Button>
              ) : (
                <div className="mt-6">
                  <p className="text-xs leading-5 text-muted-foreground">
                    This invitation is for{" "}
                    <strong className="font-medium text-foreground">
                      {preview.email}
                    </strong>
                    , but you&apos;re signed in as {user.email}.
                  </p>
                  <Button
                    className="mt-4 w-full"
                    variant="outline"
                    onClick={() => void signOut()}
                  >
                    <LogOut /> Sign out and continue
                  </Button>
                </div>
              )
            ) : preview.accountExists ? (
              <Button className="mt-6 h-11 w-full" asChild>
                <Link
                  to="/"
                  search={{ email: preview.email, redirect: invitePath }}
                >
                  Sign in to accept <ArrowRight />
                </Link>
              </Button>
            ) : (
              <InvitedAccountForm
                email={preview.email}
                pending={pending}
                onSubmit={(event) => void createAccount(event)}
              />
            )}
            <p className="type-meta mt-5 text-center text-muted-foreground">
              {user || preview.accountExists
                ? "Only the invited, verified account can accept this invitation."
                : "Creating your account accepts this invitation."}
            </p>
          </>
        )}
      </section>
    </main>
  )
}

function InvitedAccountForm({
  email,
  pending,
  onSubmit,
}: {
  email: string
  pending: boolean
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  return (
    <form onSubmit={onSubmit} className="mt-6 grid gap-4">
      <label className="type-control-sm grid gap-1.5 text-foreground">
        Email
        <Input
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          readOnly
          className="h-11 bg-card/60 read-only:bg-muted/35 read-only:text-foreground/85"
        />
      </label>
      <label className="type-control-sm grid gap-1.5 text-foreground">
        Display name
        <Input
          name="name"
          className="h-11 bg-card/60"
          autoComplete="nickname"
          minLength={1}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          required
          autoFocus
        />
      </label>
      <label className="type-control-sm grid gap-1.5 text-foreground">
        Password
        <Input
          name="password"
          type="password"
          className="h-11 bg-card/60 font-mono"
          placeholder="At least 12 characters"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
      </label>
      <label className="type-control-sm grid gap-1.5 text-foreground">
        Confirm password
        <Input
          name="confirmation"
          type="password"
          className="h-11 bg-card/60 font-mono"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
      </label>
      <Button className="mt-1 h-11 w-full" disabled={pending}>
        {pending ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
        Create account &amp; join
      </Button>
    </form>
  )
}
