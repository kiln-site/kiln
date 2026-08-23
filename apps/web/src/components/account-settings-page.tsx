import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import QRCode from "react-qr-code"
import {
  Check,
  Clipboard,
  Fingerprint,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Smartphone,
  Terminal,
  Trash2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

import { ensuringPromise, recoverPromise } from "@/effect/promise"
import { authClient } from "@/lib/auth-client"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { clearAppearanceCache } from "@/lib/appearance"
import { getCliCredentials, revokeCliCredential } from "@/server/cli"
import { getActiveSessions, revokeActiveSession } from "@/server/sessions"
import type { AccountSessionSummary } from "@/effect/account-sessions"

const accountDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})
const activeSessionsQueryKey = ["account", "active-sessions"] as const
const linkedCliQueryKey = ["account", "linked-clis"] as const

type ActiveSession = AccountSessionSummary

interface SetupState {
  backupCodes: Array<string>
  totpURI: string
}

interface TwoFactorFormState {
  open: boolean
  password: string
  setup: SetupState | null
  totpCode: string
}

type TwoFactorFormAction =
  | { type: "patch"; value: Partial<TwoFactorFormState> }
  | { type: "reset" }

const initialTwoFactorFormState: TwoFactorFormState = {
  open: false,
  password: "",
  setup: null,
  totpCode: "",
}

function twoFactorFormReducer(
  state: TwoFactorFormState,
  action: TwoFactorFormAction
): TwoFactorFormState {
  if (action.type === "reset") return initialTwoFactorFormState
  return { ...state, ...action.value }
}

export function AccountSettingsPage({ user }: { user: AuthenticatedUser }) {
  return (
    <div className="w-full max-w-2xl px-5 pb-12">
      <fieldset
        disabled={user.isDevelopmentBypass}
        className={`min-w-0 border-0 p-0 ${user.isDevelopmentBypass ? "opacity-45" : ""}`}
      >
        <div className="border-b">
          <EmailAddressCard initialEmail={user.email} />
          <PasswordCard />
          <TwoFactorCard />
          {user.isDevelopmentBypass ? (
            <DisabledPasskeysCard />
          ) : (
            <PasskeysCard />
          )}
          <CliCredentialsCard enabled={!user.isDevelopmentBypass} />
          <SessionsCard enabled={!user.isDevelopmentBypass} />
        </div>
      </fieldset>
    </div>
  )
}

function EmailAddressCard({ initialEmail }: { initialEmail: string }) {
  const session = authClient.useSession()
  const [open, setOpen] = React.useState(false)
  const [email, setEmail] = React.useState(initialEmail)
  const [code, setCode] = React.useState("")
  const [requestedEmail, setRequestedEmail] = React.useState<string | null>(
    null
  )
  const [pending, setPending] = React.useState<"request" | "verify" | null>(
    null
  )
  const currentEmail = session.data?.user.email ?? initialEmail

  React.useEffect(() => setEmail(currentEmail), [currentEmail])

  async function requestEmailChange(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextEmail = email.trim().toLowerCase()
    if (nextEmail === currentEmail.toLowerCase()) {
      showToast({
        message: "Enter a different email address.",
        type: "error",
      })
      return
    }

    setPending("request")
    const result = await recoverPromise(
      () => authClient.emailOtp.requestEmailChange({ newEmail: nextEmail }),
      (cause) => failedAuthResult(cause, "Could not send a verification code")
    )
    setPending(null)
    if (result.error) {
      showToast({
        message: authErrorMessage(
          result.error,
          "Could not send a verification code"
        ),
        type: "error",
      })
      return
    }

    setRequestedEmail(nextEmail)
    showToast({
      message: "Verification code sent.",
      type: "success",
    })
  }

  async function confirmEmailChange(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!requestedEmail) return
    const otp = code.replace(/\s/gu, "")
    if (!/^\d{6}$/u.test(otp)) {
      showToast({ message: "Enter the six-digit code", type: "error" })
      return
    }

    setPending("verify")
    const result = await recoverPromise(
      () => authClient.emailOtp.changeEmail({ newEmail: requestedEmail, otp }),
      (cause) => failedAuthResult(cause, "Could not verify the email change")
    )
    setPending(null)
    if (result.error) {
      showToast({
        message: authErrorMessage(
          result.error,
          "Could not verify the email change"
        ),
        type: "error",
      })
      return
    }

    showToast({ message: "Email address changed.", type: "success" })
    changeOpen(false)
    await session.refetch()
  }

  function changeOpen(nextOpen: boolean) {
    if (pending) return
    setOpen(nextOpen)
    if (!nextOpen) {
      setEmail(currentEmail)
      setCode("")
      setRequestedEmail(null)
    }
  }

  return (
    <AccountSection title="Email address">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <p className="truncate text-xs text-muted-foreground">{currentEmail}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setOpen(true)}
        >
          Change
        </Button>
      </div>

      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change email address</DialogTitle>
            <DialogDescription>
              {requestedEmail
                ? `Enter the code sent to ${requestedEmail}.`
                : `We’ll send a verification code before replacing ${currentEmail}.`}
            </DialogDescription>
          </DialogHeader>
          {requestedEmail ? (
            <form className="grid gap-4" onSubmit={confirmEmailChange}>
              <Field label="Verification code" htmlFor="account-email-code">
                <Input
                  id="account-email-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  className="h-10 bg-background/70 font-mono tracking-[0.22em]"
                  required
                  autoFocus
                />
              </Field>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setCode("")
                    setRequestedEmail(null)
                  }}
                  disabled={pending !== null}
                >
                  Back
                </Button>
                <Button type="submit" disabled={pending !== null}>
                  {pending === "verify" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : null}
                  Verify email
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <form className="grid gap-4" onSubmit={requestEmailChange}>
              <Field label="New email address" htmlFor="account-email">
                <Input
                  id="account-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  className="h-10 bg-background/70"
                  required
                  autoFocus
                />
              </Field>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => changeOpen(false)}
                  disabled={pending !== null}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={pending !== null || !email.trim()}
                >
                  {pending === "request" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : null}
                  Send code
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </AccountSection>
  )
}

function PasswordCard() {
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [currentPassword, setCurrentPassword] = React.useState("")
  const [newPassword, setNewPassword] = React.useState("")
  const [confirmation, setConfirmation] = React.useState("")
  const [pending, setPending] = React.useState(false)

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const validation = validateNewPassword(newPassword, confirmation)
    if (validation) {
      showToast({ message: validation, type: "error" })
      return
    }

    setPending(true)
    const result = await ensuringPromise(
      () =>
        recoverPromise(
          () =>
            authClient.changePassword({
              currentPassword,
              newPassword,
              revokeOtherSessions: true,
            }),
          (cause) => failedAuthResult(cause, "Could not change your password")
        ),
      () => setPending(false)
    )
    if (result.error) {
      showToast({
        message: authErrorMessage(
          result.error,
          "Could not change your password"
        ),
        type: "error",
      })
      return
    }

    showToast({
      message: "Password changed. Other active sessions were signed out.",
      type: "success",
    })
    changeOpen(false)
    await queryClient.invalidateQueries({ queryKey: activeSessionsQueryKey })
  }

  function changeOpen(nextOpen: boolean) {
    if (pending) return
    setOpen(nextOpen)
    if (!nextOpen) {
      setCurrentPassword("")
      setNewPassword("")
      setConfirmation("")
    }
  }

  return (
    <AccountSection title="Password">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
        >
          Change password
        </Button>
      </div>

      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              Updating your password will sign out your other active sessions.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-3" onSubmit={changePassword}>
            <Field label="Current password" htmlFor="current-password">
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                className="h-10 bg-background/70 font-mono"
                required
                autoFocus
              />
            </Field>
            <Field label="New password" htmlFor="new-password">
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                className="h-10 bg-background/70 font-mono"
                required
              />
            </Field>
            <Field label="Confirm password" htmlFor="confirm-new-password">
              <Input
                id="confirm-new-password"
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                className="h-10 bg-background/70 font-mono"
                required
              />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => changeOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <LoaderCircle className="animate-spin" /> : null}
                Update password
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AccountSection>
  )
}

function TwoFactorCard() {
  const session = authClient.useSession()
  const queryClient = useQueryClient()
  const [form, dispatchForm] = React.useReducer(
    twoFactorFormReducer,
    initialTwoFactorFormState
  )
  const [pending, setPending] = React.useState<string | null>(null)
  const { open, password, setup, totpCode } = form
  const twoFactorEnabled = Boolean(
    Reflect.get(session.data?.user ?? {}, "twoFactorEnabled")
  )

  async function beginTwoFactor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending("enable")
    const result = await recoverPromise(
      () => authClient.twoFactor.enable({ password }),
      (cause) => failedAuthResult(cause, "Could not begin 2FA setup")
    )
    setPending(null)
    if (result.error) {
      showToast({
        message: authErrorMessage(result.error, "Could not begin 2FA setup"),
        type: "error",
      })
      return
    }
    if (!result.data) {
      showToast({ message: "Could not begin 2FA setup", type: "error" })
      return
    }
    dispatchForm({ type: "patch", value: { setup: result.data } })
  }

  async function confirmTwoFactor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = totpCode.replace(/\s/gu, "")
    if (!/^\d{6}$/u.test(code)) {
      showToast({ message: "Enter the six-digit code", type: "error" })
      return
    }
    setPending("verify")
    const result = await recoverPromise(
      () => authClient.twoFactor.verifyTotp({ code }),
      (cause) => failedAuthResult(cause, "The authenticator code is invalid")
    )
    setPending(null)
    if (result.error) {
      showToast({
        message: authErrorMessage(
          result.error,
          "The authenticator code is invalid"
        ),
        type: "error",
      })
      return
    }
    dispatchForm({ type: "reset" })
    showToast({ message: "Authenticator app enabled.", type: "success" })
    await session.refetch()
    await queryClient.invalidateQueries({ queryKey: activeSessionsQueryKey })
  }

  async function disableTwoFactor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending("disable")
    const result = await recoverPromise(
      () => authClient.twoFactor.disable({ password }),
      (cause) => failedAuthResult(cause, "Could not disable 2FA")
    )
    setPending(null)
    if (result.error) {
      showToast({
        message: authErrorMessage(result.error, "Could not disable 2FA"),
        type: "error",
      })
      return
    }
    dispatchForm({ type: "reset" })
    showToast({ message: "Authenticator app disabled.", type: "success" })
    await session.refetch()
    await queryClient.invalidateQueries({ queryKey: activeSessionsQueryKey })
  }

  async function copyRecoveryCodes() {
    if (!setup) return
    const result = await recoverPromise(
      () => navigator.clipboard.writeText(setup.backupCodes.join("\n")),
      (cause) => cause
    )
    if (result) {
      showToast({
        message: authErrorMessage(result, "Could not copy recovery codes"),
        type: "error",
      })
      return
    }
    showToast({ message: "Recovery codes copied.", type: "success" })
  }

  function changeOpen(nextOpen: boolean) {
    if (pending) return
    dispatchForm(
      nextOpen ? { type: "patch", value: { open: true } } : { type: "reset" }
    )
  }

  return (
    <AccountSection title="Authenticator app">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {twoFactorEnabled ? "Enabled" : "Not set up"}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => changeOpen(true)}
        >
          {twoFactorEnabled ? "Manage" : "Set up"}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className={setup ? "sm:max-w-xl" : undefined}>
          <DialogHeader>
            <DialogTitle>
              {twoFactorEnabled
                ? "Disable authenticator app"
                : "Set up authenticator app"}
            </DialogTitle>
            <DialogDescription>
              {setup
                ? "Scan the QR code, save your recovery codes, then verify the current code."
                : twoFactorEnabled
                  ? "Confirm your password to remove this second factor."
                  : "Confirm your password to generate an authenticator key."}
            </DialogDescription>
          </DialogHeader>

          {setup && !twoFactorEnabled ? (
            <form className="grid gap-4" onSubmit={confirmTwoFactor}>
              <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
                <div className="self-start border bg-white p-2.5">
                  <QRCode value={setup.totpURI} className="h-auto w-full" />
                </div>
                <div className="min-w-0">
                  <code className="type-code block truncate border bg-background px-2 py-1.5 text-muted-foreground">
                    {readTotpSecret(setup.totpURI)}
                  </code>
                  <Field label="Six-digit code" htmlFor="account-totp-code">
                    <Input
                      id="account-totp-code"
                      value={totpCode}
                      onChange={(event) =>
                        dispatchForm({
                          type: "patch",
                          value: { totpCode: event.target.value },
                        })
                      }
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="000000"
                      className="mt-2 h-9 font-mono tracking-[0.22em]"
                      required
                      autoFocus
                    />
                  </Field>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between gap-3">
                  <p className="type-label">Recovery codes</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => void copyRecoveryCodes()}
                  >
                    <Clipboard /> Copy all
                  </Button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1 border bg-background/65 p-3 sm:grid-cols-5">
                  {setup.backupCodes.map((code) => (
                    <code
                      key={code}
                      className="type-meta text-center font-mono text-foreground"
                    >
                      {code}
                    </code>
                  ))}
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => changeOpen(false)}
                  disabled={pending !== null}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={pending !== null}>
                  {pending === "verify" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Check />
                  )}
                  Verify and enable
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={twoFactorEnabled ? disableTwoFactor : beginTwoFactor}
            >
              <Field label="Current password" htmlFor="totp-password">
                <Input
                  id="totp-password"
                  type="password"
                  value={password}
                  onChange={(event) =>
                    dispatchForm({
                      type: "patch",
                      value: { password: event.target.value },
                    })
                  }
                  autoComplete="current-password"
                  className="h-10 bg-background/70"
                  required
                  autoFocus
                />
              </Field>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => changeOpen(false)}
                  disabled={pending !== null}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant={twoFactorEnabled ? "destructive" : "default"}
                  disabled={pending !== null}
                >
                  {pending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : twoFactorEnabled ? (
                    <LockKeyhole />
                  ) : null}
                  {twoFactorEnabled ? "Disable" : "Continue"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </AccountSection>
  )
}

function PasskeysCard() {
  const passkeys = authClient.useListPasskeys()
  const session = authClient.useSession()
  const queryClient = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [passkeyName, setPasskeyName] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [pending, setPending] = React.useState<string | null>(null)

  async function addPasskey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!("PublicKeyCredential" in window)) {
      showToast({
        message: "This browser does not support passkeys.",
        type: "error",
      })
      return
    }
    setPending("add")
    const confirmation = await recoverPromise(
      () => authClient.passwordConfirmation.confirm({ password }),
      (cause) => failedAuthResult(cause, "Could not confirm your password")
    )
    if (confirmation.error) {
      setPending(null)
      setPassword("")
      showToast({
        message: hasAuthErrorCode(confirmation.error, "INVALID_PASSWORD")
          ? "Incorrect password. Try again."
          : authErrorMessage(
              confirmation.error,
              "Could not confirm your password"
            ),
        type: "error",
      })
      return
    }

    setPassword("")
    await Promise.all([
      session.refetch(),
      queryClient.invalidateQueries({ queryKey: activeSessionsQueryKey }),
    ])
    const result = await recoverPromise(
      () =>
        authClient.passkey.addPasskey({
          name: passkeyName.trim() || "Kiln passkey",
        }),
      (cause) => failedAuthResult(cause, "Could not add the passkey")
    )
    setPending(null)
    if (result.error) {
      if (isSessionNotFresh(result.error)) {
        showToast({
          message:
            "Your password confirmation expired. Enter your password and try again.",
          type: "error",
        })
        return
      }
      showToast({
        message: authErrorMessage(result.error, "Could not add the passkey"),
        type: "error",
      })
      return
    }
    setPasskeyName("")
    changeOpen(false)
    showToast({ message: "Passkey added.", type: "success" })
    await passkeys.refetch()
  }

  function changeOpen(nextOpen: boolean) {
    if (pending) return
    setOpen(nextOpen)
    if (!nextOpen) {
      setPasskeyName("")
      setPassword("")
    }
  }

  async function deletePasskey(id: string) {
    setPending(id)
    const result = await recoverPromise(
      () => authClient.passkey.deletePasskey({ id }),
      (cause) => failedAuthResult(cause, "Could not remove the passkey")
    )
    setPending(null)
    if (result.error) {
      showToast({
        message: authErrorMessage(result.error, "Could not remove the passkey"),
        type: "error",
      })
      return
    }
    showToast({ message: "Passkey removed.", type: "success" })
    await passkeys.refetch()
  }

  return (
    <AccountSection title="Passkeys">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {passkeys.data?.length
            ? `${passkeys.data.length} registered`
            : "None registered"}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
        >
          Add passkey
        </Button>
      </div>
      {passkeys.data?.length ? (
        <div className="mt-3 divide-y border bg-background/45">
          {passkeys.data.map((passkey) => (
            <div
              key={passkey.id}
              className="flex items-center gap-3 px-3 py-2.5"
            >
              <span className="grid size-8 shrink-0 place-items-center border bg-card text-primary">
                <Fingerprint className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">
                  {passkey.name || "Unnamed passkey"}
                </span>
                <span className="type-technical-label mt-0.5 block text-muted-foreground">
                  {passkey.deviceType || "Authenticator"} · Added{" "}
                  {formatDate(passkey.createdAt)}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${passkey.name || "passkey"}`}
                disabled={pending !== null}
                onClick={() => void deletePasskey(passkey.id)}
              >
                {pending === passkey.id ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Trash2 />
                )}
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a passkey</DialogTitle>
            <DialogDescription>
              Confirm your password, then use this device’s fingerprint, face
              recognition, or security key.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={addPasskey}>
            <Field label="Passkey name" htmlFor="passkey-name">
              <Input
                id="passkey-name"
                value={passkeyName}
                onChange={(event) => setPasskeyName(event.target.value)}
                placeholder="MacBook"
                className="h-10 bg-background/70"
                maxLength={80}
                autoFocus
              />
            </Field>
            <Field label="Current password" htmlFor="passkey-password">
              <Input
                id="passkey-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                className="h-10 bg-background/70"
                required
              />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => changeOpen(false)}
                disabled={pending !== null}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending !== null}>
                {pending === "add" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Fingerprint />
                )}
                Continue
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AccountSection>
  )
}

function DisabledPasskeysCard() {
  return (
    <AccountSection title="Passkeys">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">None registered</p>
        <Button type="button" variant="outline" size="sm">
          Add passkey
        </Button>
      </div>
    </AccountSection>
  )
}

function CliCredentialsCard({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient()
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const linked = useQuery({
    queryKey: linkedCliQueryKey,
    enabled,
    queryFn: () => getCliCredentials(),
  })
  const active =
    linked.data?.credentials.filter((credential) => credential.active) ?? []

  async function unlink(credentialId: string) {
    setPendingId(credentialId)
    const result = await recoverPromise(
      async () => {
        await revokeCliCredential({ data: { credentialId } })
        await queryClient.invalidateQueries({ queryKey: linkedCliQueryKey })
        return { error: null }
      },
      (cause) => ({ error: cause })
    )
    setPendingId(null)
    if (result.error) {
      showToast({
        message: authErrorMessage(result.error, "Could not unlink the CLI"),
        type: "error",
      })
      return
    }
    showToast({ message: "CLI unlinked.", type: "success" })
  }

  return (
    <AccountSection title="Linked CLIs">
      <p className="mb-3 text-xs text-muted-foreground">
        {enabled
          ? `${active.length} active · full access expires after ${linked.data?.defaultAccessDays ?? 30} days by default`
          : "No persisted CLIs for the development identity"}
      </p>
      <div className="divide-y border bg-background/45">
        {!enabled ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            Sign in with an account to link a CLI
          </p>
        ) : linked.isPending ? (
          <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading CLIs
          </div>
        ) : linked.isError ? (
          <div className="px-3 py-6 text-center">
            <p className="text-xs text-destructive">
              {authErrorMessage(linked.error, "Could not load linked CLIs")}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => void linked.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : linked.data?.credentials.length ? (
          linked.data.credentials.map((credential) => {
            return (
              <div
                key={credential.id}
                className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,0.55fr)_auto] sm:items-center"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center border bg-card text-primary">
                    <Terminal className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">
                      {credential.name}
                    </span>
                    <span className="type-technical-label mt-0.5 block text-muted-foreground">
                      {credential.mode === "read_only"
                        ? "Read-only"
                        : "Full access"}
                      {!credential.active
                        ? ` · ${credential.revokedAt ? "Unlinked" : "Expired"}`
                        : " · Active"}
                    </span>
                  </span>
                </div>
                <div className="type-meta text-muted-foreground sm:text-right">
                  <span className="block">
                    Last used {formatDate(credential.lastUsedAt)}
                  </span>
                  <span className="block">
                    {credential.expiresAt
                      ? `Expires ${formatDate(credential.expiresAt)}`
                      : "No expiration"}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="justify-self-start text-muted-foreground hover:text-destructive sm:justify-self-end"
                  disabled={!credential.active || pendingId !== null}
                  onClick={() => void unlink(credential.id)}
                >
                  {pendingId === credential.id ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                  Unlink
                </Button>
              </div>
            )
          })
        ) : (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No CLIs linked yet. Run <code>kiln login</code> to connect one.
          </p>
        )}
      </div>
    </AccountSection>
  )
}

function SessionsCard({ enabled }: { enabled: boolean }) {
  const session = authClient.useSession()
  const queryClient = useQueryClient()
  const [pendingSessionId, setPendingSessionId] = React.useState<string | null>(
    null
  )
  const [logoutDialogOpen, setLogoutDialogOpen] = React.useState(false)
  const [loggingOut, setLoggingOut] = React.useState(false)
  const sessions = useQuery({
    queryKey: activeSessionsQueryKey,
    enabled,
    queryFn: () => getActiveSessions(),
  })
  const currentSessionId = session.data?.session.id

  const revokeSession = React.useCallback(
    async (activeSession: ActiveSession) => {
      const isCurrent = activeSession.id === currentSessionId
      setPendingSessionId(activeSession.id)
      const result = await recoverPromise(
        async () => {
          if (isCurrent) {
            const signOutResult = await authClient.signOut()
            if (signOutResult.error) throw signOutResult.error
          } else {
            await revokeActiveSession({
              data: { sessionId: activeSession.id },
            })
          }
          return { error: null }
        },
        (cause) => failedAuthResult(cause, "Could not revoke the session")
      )
      setPendingSessionId(null)
      const { error } = result
      if (error) {
        showToast({
          message: authErrorMessage(error, "Could not revoke the session"),
          type: "error",
        })
        return
      }
      if (isCurrent) {
        clearAppearanceCache()
        window.location.assign("/")
        return
      }
      showToast({ message: "Session revoked.", type: "success" })
      await queryClient.invalidateQueries({ queryKey: activeSessionsQueryKey })
    },
    [currentSessionId, queryClient]
  )

  async function logoutEverywhere() {
    setLoggingOut(true)
    const revokeResult = await recoverPromise(
      () => authClient.revokeSessions(),
      (cause) => failedAuthResult(cause, "Could not log out every session")
    )
    if (revokeResult.error) {
      setLoggingOut(false)
      setLogoutDialogOpen(false)
      showToast({
        message: authErrorMessage(
          revokeResult.error,
          "Could not log out every session"
        ),
        type: "error",
      })
      return
    }
    await recoverPromise(
      () => authClient.signOut(),
      () => ({ data: null, error: null })
    )
    clearAppearanceCache()
    window.location.assign("/")
  }

  return (
    <AccountSection title="Active sessions">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {sessions.data?.length ?? 0} active
        </p>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => setLogoutDialogOpen(true)}
          disabled={!sessions.data?.length}
        >
          <LogOut /> Log out everywhere
        </Button>
      </div>
      <div className="divide-y border bg-background/45">
        {!enabled ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No persisted sessions for the development identity
          </p>
        ) : sessions.isPending ? (
          <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading sessions
          </div>
        ) : sessions.isError ? (
          <div className="px-3 py-6 text-center">
            <p className="text-xs text-destructive">
              {authErrorMessage(
                sessions.error,
                "Could not load active sessions"
              )}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => void sessions.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : sessions.data?.length ? (
          sessions.data.map((activeSession) => (
            <SessionRow
              key={activeSession.id}
              activeSession={activeSession}
              current={activeSession.id === currentSessionId}
              pending={pendingSessionId === activeSession.id}
              disabled={pendingSessionId !== null || loggingOut}
              onRevoke={revokeSession}
            />
          ))
        ) : (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No active sessions found
          </p>
        )}
      </div>

      <Dialog open={logoutDialogOpen} onOpenChange={setLogoutDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log out everywhere?</DialogTitle>
            <DialogDescription>
              Every active session, including this browser, will be revoked.
              You’ll need to sign in again on each device.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setLogoutDialogOpen(false)}
              disabled={loggingOut}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void logoutEverywhere()}
              disabled={loggingOut}
            >
              {loggingOut ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <LogOut />
              )}
              Log out all sessions
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AccountSection>
  )
}

const SessionRow = React.memo(function SessionRow({
  activeSession,
  current,
  pending,
  disabled,
  onRevoke,
}: {
  activeSession: ActiveSession
  current: boolean
  pending: boolean
  disabled: boolean
  onRevoke: (activeSession: ActiveSession) => void
}) {
  const device = describeUserAgent(activeSession.userAgent)
  const DeviceIcon = device.mobile ? Smartphone : Laptop

  return (
    <div className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.55fr)_auto] sm:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center border bg-card text-primary">
          <DeviceIcon className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate text-xs font-medium">
              {device.browser} on {device.platform}
            </span>
            {current ? (
              <span className="type-technical-label shrink-0 border border-emerald-500/25 bg-emerald-500/8 px-1.5 py-0.5 text-emerald-500">
                Current
              </span>
            ) : null}
          </span>
          <span className="type-technical-label mt-0.5 block truncate text-muted-foreground">
            {activeSession.ipAddress || "IP unavailable"}
          </span>
        </span>
      </div>
      <div className="type-meta text-muted-foreground sm:text-right">
        <span className="block">
          Started {formatDate(activeSession.createdAt)}
        </span>
        <span className="block">
          Expires {formatDate(activeSession.expiresAt)}
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-self-start text-muted-foreground hover:text-destructive sm:justify-self-end"
        aria-label={current ? "Sign out this session" : "Revoke this session"}
        disabled={disabled}
        onClick={() => onRevoke(activeSession)}
      >
        {pending ? (
          <LoaderCircle className="animate-spin" />
        ) : current ? (
          <LogOut />
        ) : (
          <Trash2 />
        )}
        {current ? "Sign out" : "Revoke"}
      </Button>
    </div>
  )
})

function AccountSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  const headingId = React.useId()
  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-3 border-b py-5 last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-start"
    >
      <h2 id={headingId} className="text-xs font-medium text-foreground">
        {title}
      </h2>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <label className="grid gap-1.5" htmlFor={htmlFor}>
      <span className="type-label text-foreground">{label}</span>
      {children}
    </label>
  )
}

function failedAuthResult(cause: unknown, fallback: string) {
  return {
    data: null,
    error: { message: authErrorMessage(cause, fallback) },
  }
}

function authErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error !== "object" || error === null) return fallback
  const message = Reflect.get(error, "message")
  if (typeof message === "string" && message) return message
  const statusText = Reflect.get(error, "statusText")
  return typeof statusText === "string" && statusText ? statusText : fallback
}

function isSessionNotFresh(error: unknown): boolean {
  if (hasAuthErrorCode(error, "SESSION_NOT_FRESH")) return true
  if (typeof error !== "object" || error === null) return false
  return Reflect.get(error, "message") === "Session is not fresh"
}

function hasAuthErrorCode(error: unknown, expectedCode: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === expectedCode
  )
}

function validateNewPassword(
  password: string,
  confirmation: string
): string | null {
  if (password.length < 12)
    return "Use at least 12 characters for your password"
  if (password.length > 128)
    return "Use no more than 128 characters for your password"
  if (password !== confirmation) return "The passwords do not match"
  return null
}

function readTotpSecret(uri: string): string {
  const parsed = recoverUrl(uri)
  return parsed?.searchParams.get("secret") ?? ""
}

function recoverUrl(value: string): URL | null {
  if (!URL.canParse(value)) return null
  return new URL(value)
}

function formatDate(value?: Date | string | null): string {
  if (!value) return "recently"
  return accountDateFormatter.format(new Date(value))
}

function describeUserAgent(userAgent?: string | null): {
  browser: string
  mobile: boolean
  platform: string
} {
  const value = userAgent ?? ""
  const browser = /Edg\//u.test(value)
    ? "Edge"
    : /Firefox\//u.test(value)
      ? "Firefox"
      : /Chrome\//u.test(value)
        ? "Chrome"
        : /Safari\//u.test(value)
          ? "Safari"
          : "Unknown browser"
  const platform = /iPhone|iPad/u.test(value)
    ? "iOS"
    : /Android/u.test(value)
      ? "Android"
      : /Mac OS X|Macintosh/u.test(value)
        ? "macOS"
        : /Windows/u.test(value)
          ? "Windows"
          : /Linux/u.test(value)
            ? "Linux"
            : "Unknown device"
  return {
    browser,
    platform,
    mobile: /Mobile|Android|iPhone|iPad/u.test(value),
  }
}
