import { ensuringPromise, recoverPromise } from "@/effect/promise"
import { useState, type FormEvent } from "react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

import { AccountSettingsPage } from "@/components/account-settings-page"
import { AccountStatusSync } from "@/components/account-status-sync"
import { AuthBrand, AuthPageShell } from "@/components/auth-page-shell"
import { isAccountVerified } from "@/lib/account-policy"
import { authClient } from "@/lib/auth-client"
import type { AuthenticatedUser } from "@/lib/auth-session"

export function AccountStatusPage({
  user,
  emailDeliveryEnabled,
  resumePath = "/",
}: {
  user: AuthenticatedUser
  emailDeliveryEnabled: boolean
  resumePath?: string
}) {
  const verified = isAccountVerified(user)
  return (
    <AuthPageShell wide={verified}>
      <AccountStatusSync restricted resumePath={resumePath} />
      <div>
        <header className="mb-8 grid justify-items-center gap-4 text-center">
          <AuthBrand />
          <h1 className="font-heading text-2xl font-semibold tracking-[-0.04em]">
            {verified ? "Your account is disabled" : "Verify your account"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {verified
              ? "Your assignments are preserved. Access resumes here when an administrator enables your account. You can still manage your profile and security."
              : "Confirm your email or redeem a manual claim issued by a platform administrator to continue."}
          </p>
          {user.statusReason ? (
            <p className="text-sm">{user.statusReason}</p>
          ) : null}
          <Button
            variant="outline"
            className="w-fit"
            onClick={async () => {
              const result = await authClient.signOut()
              if (result.error)
                showToast({
                  type: "error",
                  message: result.error.message ?? "Could not sign out",
                })
              else window.location.assign("/")
            }}
          >
            Sign out
          </Button>
        </header>
        {verified ? (
          <AccountSettingsPage user={user} />
        ) : emailDeliveryEnabled ? (
          <EmailVerification email={user.email} resumePath={resumePath} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Email delivery is unavailable. Ask a platform administrator for
            manual verification.
          </p>
        )}
      </div>
    </AuthPageShell>
  )
}
function EmailVerification({
  email,
  resumePath,
}: {
  email: string
  resumePath: string
}) {
  const [pending, setPending] = useState(false)
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const otp = String(new FormData(event.currentTarget).get("code") ?? "")
    setPending(true)
    await ensuringPromise(
      () =>
        recoverPromise(
          async () => {
            const result = await authClient.emailOtp.verifyEmail({ email, otp })
            if (result.error)
              throw new Error(result.error.message ?? "Could not verify email")
            showToast({ type: "success", message: "Email verified" })
            window.location.replace(resumePath)
          },
          (cause) => {
            showToast({
              type: "error",
              message:
                cause instanceof Error
                  ? cause.message
                  : "Could not verify email",
            })
          }
        ),
      () => {
        setPending(false)
      }
    )
  }
  return (
    <section className="max-w-sm space-y-4">
      <label className="type-control-sm grid gap-1.5 text-foreground">
        Email
        <Input
          type="email"
          autoComplete="email"
          value={email}
          readOnly
          className="h-11 bg-card/60 read-only:bg-muted/35 read-only:text-foreground/85"
        />
      </label>
      <form onSubmit={verify} className="grid gap-3">
        <label className="type-control-sm grid gap-1.5 text-foreground">
          Verification code
          <Input
            name="code"
            className="h-11 bg-card/60 font-mono tracking-[0.28em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
          />
        </label>
        <Button className="h-11" disabled={pending}>
          Verify email
        </Button>
      </form>
      <Button
        variant="outline"
        className="h-11 w-full"
        disabled={pending}
        onClick={async () => {
          setPending(true)
          await ensuringPromise(
            () =>
              recoverPromise(
                async () => {
                  const result = await authClient.emailOtp.sendVerificationOtp({
                    email,
                    type: "email-verification",
                  })
                  if (result.error)
                    throw new Error(
                      result.error.message ?? "Could not send code"
                    )
                  showToast({
                    type: "success",
                    message: "Verification code sent",
                  })
                },
                (cause) => {
                  showToast({
                    type: "error",
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Could not send code",
                  })
                }
              ),
            () => {
              setPending(false)
            }
          )
        }}
      >
        Send verification code
      </Button>
    </section>
  )
}
