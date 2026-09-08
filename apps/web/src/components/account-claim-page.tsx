import { useMutation } from "@tanstack/react-query"
import { useState, type FormEvent } from "react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

import { AuthBrand, AuthPageShell } from "@/components/auth-page-shell"
import { authClient } from "@/lib/auth-client"
import { claimAccount } from "@/server/users"
import { accountReturnPath } from "@/lib/account-return-path"

export function AccountClaimPage({
  token,
  email,
  redirectPath,
}: {
  token: string
  email?: string
  redirectPath?: string
}) {
  const [confirmationError, setConfirmationError] = useState<string | null>(
    null
  )
  const mutation = useMutation({
    mutationFn: async ({
      password,
      displayName,
    }: {
      password: string
      displayName: string
    }) => {
      const result = await claimAccount({
        data: { token, password, displayName },
      })
      showToast({
        type: "success",
        message: "Account claimed. You can now accept your invitations.",
      })
      const login = await authClient.signIn.email({
        email: result.email,
        password,
      })
      if (login.error) {
        window.location.assign(`/?email=${encodeURIComponent(result.email)}`)
        return
      }
      const stored =
        redirectPath ?? sessionStorage.getItem("kiln:claim:return") ?? "/"
      sessionStorage.removeItem("kiln:claim:return")
      window.location.assign(accountReturnPath(stored))
    },
  })
  const pending = mutation.isPending
  const error = confirmationError ?? mutation.error?.message
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const form = new FormData(event.currentTarget)
    const password = String(form.get("password") ?? "")
    if (password !== form.get("confirmation")) {
      setConfirmationError("The passwords do not match")
      return
    }
    setConfirmationError(null)
    mutation.mutate({ password, displayName: String(form.get("name") ?? "") })
  }
  return (
    <AuthPageShell>
      <div className="mb-8 flex flex-col items-center text-center">
        <AuthBrand />
        <h1 className="mt-6 font-heading text-2xl font-semibold tracking-[-0.04em]">
          Claim your account
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose your name and password. You can accept your resource
          invitations after signing in.
        </p>
      </div>
      {!email ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-xs leading-5 text-red-300"
        >
          This claim link is invalid or expired. Request a new link to continue.
        </p>
      ) : (
        <>
          {error ? (
            <p
              role="alert"
              className="mb-4 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-xs leading-5 text-red-300"
            >
              {error}
            </p>
          ) : null}
          <form onSubmit={submit} className="grid gap-4">
            <label className="type-control-sm grid gap-1.5 text-foreground">
              Email
              <Input
                name="email"
                type="email"
                autoComplete="email"
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
                maxLength={16}
                required
              />
            </label>
            <label className="type-control-sm grid gap-1.5 text-foreground">
              Password
              <Input
                name="password"
                type="password"
                className="h-11 bg-card/60 font-mono"
                placeholder="••••••••••••"
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
                placeholder="••••••••••••"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </label>
            <Button className="mt-1 h-11 w-full" disabled={pending}>
              {pending ? "Claiming account…" : "Claim account"}
            </Button>
          </form>
        </>
      )}
      <a
        href="/"
        className="mt-5 block text-center text-xs text-muted-foreground hover:text-foreground"
      >
        Back to sign in
      </a>
    </AuthPageShell>
  )
}
