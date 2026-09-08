import { useMutation } from "@tanstack/react-query"
import { useState, type FormEvent } from "react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

import { HearthMark } from "@/components/hearth-mark"
import { authClient } from "@/lib/auth-client"
import { claimAccount } from "@/server/users"
import { accountReturnPath } from "@/lib/account-return-path"

export function AccountClaimPage({
  token,
  redirectPath,
}: {
  token: string
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
    <main className="grid min-h-dvh place-items-center bg-background p-6">
      <section className="w-full max-w-sm space-y-5">
        <HearthMark className="size-10" />
        <h1 className="text-2xl font-semibold">Claim your account</h1>
        <p className="text-sm text-muted-foreground">
          Choose your name and password. Resource invitations remain yours to
          accept individually.
        </p>
        {!token ? (
          <p role="alert" className="text-sm text-destructive">
            This claim link is invalid. Request a new link to continue.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <form onSubmit={submit} className="grid gap-4">
          <label className="grid gap-2 text-sm">
            Display name
            <Input
              name="name"
              autoComplete="nickname"
              minLength={1}
              maxLength={16}
              required
            />
          </label>
          <label className="grid gap-2 text-sm">
            Password
            <Input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
          </label>
          <label className="grid gap-2 text-sm">
            Confirm password
            <Input
              name="confirmation"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
          </label>
          <Button disabled={pending || !token}>
            {pending ? "Claiming account…" : "Claim account"}
          </Button>
        </form>
        <a href="/" className="text-sm text-muted-foreground underline">
          Back to sign in
        </a>
      </section>
    </main>
  )
}
