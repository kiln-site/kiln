import * as React from "react"
import { Effect } from "effect"
import {
  Check,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  Mail,
  RefreshCw,
  Sparkles,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"

import { HearthMark } from "@/components/hearth-mark"
import { authClient } from "@/lib/auth-client"
import { DISPLAY_NAME_MAX_LENGTH, parseDisplayName } from "@/lib/display-name"
import {
  createInitialAdministrator,
  enableDevelopmentBypass,
  getAuthState,
  replacePendingAccountEmail,
} from "@/server/auth"

type AuthMode = "forgot-password" | "setup" | "sign-in" | "sign-up"
type Feedback = { message: string; tone: "error" | "success" }
type VerificationState = {
  email: string
  password: string
  registeredEmail: string
  source: "setup" | "sign-up"
}

export function AuthPage({
  redirectPath,
  developmentBypassEnabled = false,
  emailDeliveryEnabled = false,
  forgotPassword,
  initialEmail,
  lockedEmail,
  setupRequired = false,
  signupEnabled = false,
  startWithSignup,
  verified,
}: {
  redirectPath?: string
  developmentBypassEnabled?: boolean
  emailDeliveryEnabled?: boolean
  forgotPassword?: boolean
  initialEmail?: string
  lockedEmail?: string
  setupRequired?: boolean
  signupEnabled?: boolean
  startWithSignup?: boolean
  verified?: boolean
}) {
  const [mode, setMode] = React.useState<AuthMode>(
    setupRequired
      ? "setup"
      : forgotPassword
        ? "forgot-password"
        : startWithSignup && signupEnabled
          ? "sign-up"
          : "sign-in"
  )
  const [pending, setPending] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [verification, setVerification] =
    React.useState<VerificationState | null>(null)
  const [verificationFeedback, setVerificationFeedback] =
    React.useState<Feedback | null>(null)
  const [recoveryEmail, setRecoveryEmail] = React.useState<string | null>(null)
  const [recoveryComplete, setRecoveryComplete] = React.useState(false)
  const [hydrated, setHydrated] = React.useState(false)

  React.useEffect(() => setHydrated(true), [])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(mode)
    const form = new FormData(event.currentTarget)
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase()
    const password = String(form.get("password") ?? "")
    const invitedEmail = lockedEmail?.trim().toLowerCase()

    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          if (invitedEmail && email !== invitedEmail) {
            throw new Error(
              "This invitation is only valid for its original email."
            )
          }
          if (mode === "forgot-password") {
            const result = await authClient.emailOtp.requestPasswordReset({
              email,
            })
            if (result.error) throw new Error(readAuthError(result.error))
            setRecoveryEmail(email)
            return
          }

          if (mode === "setup" || mode === "sign-up") {
            const displayName = parseDisplayName(
              String(form.get("displayName") ?? "")
            )
            const confirmPassword = String(form.get("confirmPassword") ?? "")
            validateNewPassword(password, confirmPassword)

            if (mode === "setup") {
              const result = await createInitialAdministrator({
                data: { displayName, email, password },
              })
              if (result.verificationRequired) {
                setVerification({
                  email: result.email,
                  password,
                  registeredEmail: result.email,
                  source: "setup",
                })
                return
              }
              await signIn(email, password, redirectPath)
              return
            }

            const result = await authClient.signUp.email({
              name: displayName,
              email,
              password,
              callbackURL: destination(redirectPath),
            })
            if (result.error) throw new Error(readAuthError(result.error))
            if (!emailDeliveryEnabled) {
              await signIn(email, password, redirectPath)
              return
            }
            setVerification({
              email,
              password,
              registeredEmail: email,
              source: "sign-up",
            })
            return
          }

          sessionStorage.setItem("kiln:auth:return", returnPath(redirectPath))
          const result = await authClient.signIn.email({
            email,
            password,
            callbackURL: destination(redirectPath),
          })
          if (result.error) {
            sessionStorage.removeItem("kiln:auth:return")
            if (isUnverifiedError(result.error)) {
              setVerification({
                email,
                password,
                registeredEmail: email,
                source: "sign-up",
              })
              return
            }
            throw new Error(readAuthError(result.error))
          }
          if (
            "twoFactorRedirect" in result.data &&
            result.data.twoFactorRedirect
          ) {
            window.location.assign("/two-factor")
            return
          }
          sessionStorage.removeItem("kiln:auth:return")
          window.location.assign(destination(redirectPath))
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            setError(
              cause instanceof Error ? cause.message : "Authentication failed"
            )
          )
        ),
        Effect.ensuring(Effect.sync(() => setPending(null)))
      )
    )
  }

  async function verifyEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!verification) return
    setPending("verify")
    setVerificationFeedback(null)
    const form = new FormData(event.currentTarget)
    const code = String(form.get("code") ?? "").replace(/\s/gu, "")
    const nextEmail = verification.email.trim().toLowerCase()
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          if (nextEmail !== verification.registeredEmail) {
            const result = await replacePendingAccountEmail({
              data: {
                currentEmail: verification.registeredEmail,
                nextEmail,
                password: verification.password,
              },
            })
            setVerification({
              ...verification,
              email: result.email,
              registeredEmail: result.email,
            })
            setVerificationFeedback({
              message: "Email updated. A new verification code is ready.",
              tone: "success",
            })
            return
          }
          if (!/^\d{6}$/u.test(code))
            throw new Error("Enter the six-digit code")
          const result = await authClient.emailOtp.verifyEmail({
            email: verification.registeredEmail,
            otp: code,
          })
          if (result.error) throw new Error(readAuthError(result.error))
          await signIn(
            verification.registeredEmail,
            verification.password,
            redirectPath
          )
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            setVerificationFeedback({
              message:
                cause instanceof Error ? cause.message : "Could not verify",
              tone: "error",
            })
          )
        ),
        Effect.ensuring(Effect.sync(() => setPending(null)))
      )
    )
  }

  async function resendVerificationCode() {
    if (!verification) return
    setPending("resend")
    setVerificationFeedback(null)
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          const nextEmail = verification.email.trim().toLowerCase()
          if (nextEmail !== verification.registeredEmail) {
            const result = await replacePendingAccountEmail({
              data: {
                currentEmail: verification.registeredEmail,
                nextEmail,
                password: verification.password,
              },
            })
            setVerification({
              ...verification,
              email: result.email,
              registeredEmail: result.email,
            })
          } else {
            const result = await authClient.emailOtp.sendVerificationOtp({
              email: verification.registeredEmail,
              type: "email-verification",
            })
            if (result.error) throw new Error(readAuthError(result.error))
          }
          setVerificationFeedback({
            message: emailDeliveryEnabled
              ? "A fresh code is on its way."
              : "A fresh code was written to the Hearth container logs.",
            tone: "success",
          })
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            setVerificationFeedback({
              message:
                cause instanceof Error ? cause.message : "Could not resend",
              tone: "error",
            })
          )
        ),
        Effect.ensuring(Effect.sync(() => setPending(null)))
      )
    )
  }

  async function resetPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!recoveryEmail) return
    const form = new FormData(event.currentTarget)
    const code = String(form.get("code") ?? "").replace(/\s/gu, "")
    const password = String(form.get("password") ?? "")
    const confirmation = String(form.get("confirmPassword") ?? "")
    setPending("reset")
    setError(null)
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          validateNewPassword(password, confirmation)
          if (!/^\d{6}$/u.test(code))
            throw new Error("Enter the six-digit code")
          const result = await authClient.emailOtp.resetPassword({
            email: recoveryEmail,
            otp: code,
            password,
          })
          if (result.error) throw new Error(readAuthError(result.error))
          setRecoveryComplete(true)
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not reset password"
            )
          )
        ),
        Effect.ensuring(Effect.sync(() => setPending(null)))
      )
    )
  }

  async function signInWithPasskey() {
    if (!("PublicKeyCredential" in window)) {
      setError("This browser does not support passkeys")
      return
    }
    setPending("passkey")
    setError(null)
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          const result = await authClient.signIn.passkey({ autoFill: false })
          if (result.error) throw new Error(readAuthError(result.error))
          if (!result.data) throw new Error("Passkey sign-in was not completed")
          sessionStorage.removeItem("kiln:auth:return")
          window.location.assign(destination(redirectPath))
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            setError(
              cause instanceof Error ? cause.message : "Passkey sign-in failed"
            )
          )
        ),
        Effect.ensuring(Effect.sync(() => setPending(null)))
      )
    )
  }

  async function skipForDevelopment() {
    setPending("development")
    setError(null)
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          await enableDevelopmentBypass()
          const state = await getAuthState()
          if (!state.user?.isDevelopmentBypass) {
            throw new Error("Development access could not be verified")
          }
          window.location.replace(destination(redirectPath))
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            setError(
              cause instanceof Error ? cause.message : "Could not continue"
            )
            setPending(null)
          })
        )
      )
    )
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background p-6 md:p-10">
      <div className="pointer-events-none absolute inset-0 bg-[image:var(--ambient-grid)] [mask-image:radial-gradient(ellipse_70%_70%_at_50%_40%,black,transparent)] bg-[size:64px_64px]" />
      <div className="pointer-events-none absolute top-[22%] left-1/2 h-44 w-72 -translate-x-1/2 rounded-full bg-primary/5 blur-[100px]" />

      <section className="relative w-full max-w-sm">
        {verification ? (
          <VerificationPanel
            deliveryEnabled={emailDeliveryEnabled}
            emailLocked={Boolean(lockedEmail)}
            feedback={verificationFeedback}
            pending={pending}
            state={verification}
            onBack={() => {
              setVerification(null)
              setVerificationFeedback(null)
              setMode(lockedEmail && startWithSignup ? "sign-up" : "sign-in")
            }}
            onChange={(email) =>
              setVerification((current) =>
                current && !lockedEmail ? { ...current, email } : current
              )
            }
            onResend={() => void resendVerificationCode()}
            onSubmit={verifyEmail}
          />
        ) : recoveryComplete ? (
          <RecoveryComplete onContinue={() => window.location.assign("/")} />
        ) : recoveryEmail ? (
          <RecoveryPanel
            deliveryEnabled={emailDeliveryEnabled}
            email={recoveryEmail}
            error={error}
            pending={pending === "reset"}
            onBack={() => {
              setRecoveryEmail(null)
              setError(null)
            }}
            onSubmit={resetPassword}
          />
        ) : (
          <>
            <AuthHeading
              lockedEmail={lockedEmail}
              mode={mode}
              signupEnabled={signupEnabled}
            />
            {mode === "setup" ? (
              <div className="mb-5 rounded-lg border border-primary/20 bg-primary/6 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
                No users exist yet. This account becomes the platform
                administrator.
                {!emailDeliveryEnabled
                  ? " Email verification is skipped because email delivery is not configured."
                  : " We’ll verify the address before signing you in."}
              </div>
            ) : null}
            {verified ? (
              <Notice icon={Check}>Email verified. You can sign in now.</Notice>
            ) : null}
            {error ? <Notice destructive>{error}</Notice> : null}

            <form
              className="mt-6 grid gap-4"
              method="post"
              onSubmit={handleSubmit}
            >
              {mode === "setup" || mode === "sign-up" ? (
                <Field label="Display Name" htmlFor="display-name">
                  <Input
                    id="display-name"
                    name="displayName"
                    type="text"
                    autoComplete="name"
                    maxLength={DISPLAY_NAME_MAX_LENGTH}
                    placeholder="Your name"
                    required
                    autoFocus
                    className="h-11 bg-card/60"
                  />
                </Field>
              ) : null}
              <Field label="Email" htmlFor="email">
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete={mode === "sign-in" ? "email webauthn" : "email"}
                  placeholder="you@example.com"
                  defaultValue={lockedEmail ?? initialEmail}
                  readOnly={Boolean(lockedEmail)}
                  required
                  autoFocus={
                    mode !== "setup" && mode !== "sign-up" && !lockedEmail
                  }
                  className="h-11 bg-card/60 read-only:bg-muted/35 read-only:text-foreground/85"
                />
              </Field>
              {mode !== "forgot-password" ? (
                <Field
                  label="Password"
                  htmlFor={mode === "sign-in" ? "password" : "new-password"}
                  action={
                    mode === "sign-in" ? (
                      <button
                        type="button"
                        className="type-control-sm text-muted-foreground transition-colors hover:text-foreground"
                        onClick={() => {
                          setMode("forgot-password")
                          setError(null)
                        }}
                      >
                        Forgot password?
                      </button>
                    ) : null
                  }
                >
                  <Input
                    key={mode}
                    id={mode === "sign-in" ? "password" : "new-password"}
                    name="password"
                    type="password"
                    minLength={mode === "sign-in" ? undefined : 12}
                    maxLength={128}
                    autoComplete={
                      mode === "sign-in"
                        ? "current-password webauthn"
                        : "new-password"
                    }
                    placeholder="••••••••••••"
                    required
                    autoFocus={
                      mode !== "setup" &&
                      mode !== "sign-up" &&
                      Boolean(lockedEmail)
                    }
                    className="h-11 bg-card/60 font-mono"
                  />
                </Field>
              ) : null}
              {mode === "setup" || mode === "sign-up" ? (
                <Field label="Confirm password" htmlFor="confirm-password">
                  <Input
                    id="confirm-password"
                    name="confirmPassword"
                    type="password"
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                    placeholder="••••••••••••"
                    required
                    className="h-11 bg-card/60 font-mono"
                  />
                </Field>
              ) : null}

              <Button
                className="mt-1 h-11 w-full"
                disabled={!hydrated || pending !== null}
              >
                {pending === mode ? (
                  <LoaderCircle className="animate-spin" />
                ) : null}
                {mode === "setup"
                  ? "Create administrator"
                  : mode === "sign-in"
                    ? "Login"
                    : mode === "sign-up"
                      ? "Create account"
                      : "Send recovery code"}
              </Button>
            </form>

            {mode === "sign-in" ? (
              <Button
                type="button"
                variant="ghost"
                className="mt-2 h-10 w-full text-muted-foreground hover:text-foreground"
                disabled={pending !== null}
                onClick={signInWithPasskey}
              >
                {pending === "passkey" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Fingerprint />
                )}
                {pending === "passkey"
                  ? "Waiting for your passkey…"
                  : "Sign in with a passkey"}
              </Button>
            ) : null}

            {mode !== "setup" ? (
              <p className="mt-5 text-center text-xs text-muted-foreground">
                {mode === "forgot-password" ? (
                  <button type="button" onClick={() => setMode("sign-in")}>
                    Back to sign in
                  </button>
                ) : lockedEmail ? (
                  <>This invitation is for {lockedEmail}.</>
                ) : mode === "sign-in" && signupEnabled ? (
                  <button
                    type="button"
                    className="font-medium text-foreground underline decoration-border underline-offset-4"
                    onClick={() => setMode("sign-up")}
                  >
                    Create an account
                  </button>
                ) : mode !== "sign-in" ? (
                  <button type="button" onClick={() => setMode("sign-in")}>
                    Back to sign in
                  </button>
                ) : (
                  "New accounts require an invitation."
                )}
              </p>
            ) : null}

            {developmentBypassEnabled && mode !== "forgot-password" ? (
              <>
                <div className="my-6 flex items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span className="text-xs text-muted-foreground">Or</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 w-full bg-card/40"
                  disabled={pending !== null}
                  onClick={skipForDevelopment}
                >
                  {pending === "development" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Sparkles />
                  )}
                  Skip login for development
                </Button>
              </>
            ) : null}
          </>
        )}
      </section>
    </main>
  )
}

function AuthHeading({
  lockedEmail,
  mode,
  signupEnabled,
}: {
  lockedEmail?: string
  mode: AuthMode
  signupEnabled: boolean
}) {
  return (
    <div className="mb-8 flex flex-col items-center text-center">
      <HearthMark className="size-11" />
      <h1 className="mt-3 font-heading text-2xl font-semibold tracking-[-0.04em]">
        {mode === "setup"
          ? "Set up Kiln"
          : mode === "sign-in"
            ? lockedEmail
              ? "Sign in to continue"
              : "Welcome to Kiln"
            : mode === "sign-up"
              ? "Create your Kiln account"
              : "Reset your password"}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {mode === "setup"
          ? "Create the first operator account."
          : mode === "sign-in"
            ? lockedEmail
              ? "Sign in with the email this invitation was sent to."
              : signupEnabled
                ? "Sign in or create a new account."
                : "Sign in to your control plane."
            : mode === "sign-up"
              ? "Use the email address tied to your invitation."
              : "We’ll send a six-digit recovery code."}
      </p>
    </div>
  )
}

function VerificationPanel({
  deliveryEnabled,
  emailLocked = false,
  feedback,
  pending,
  state,
  onBack,
  onChange,
  onResend,
  onSubmit,
}: {
  deliveryEnabled: boolean
  emailLocked?: boolean
  feedback: Feedback | null
  pending: string | null
  state: VerificationState
  onBack: () => void
  onChange: (email: string) => void
  onResend: () => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  const changed =
    !emailLocked && state.email.trim().toLowerCase() !== state.registeredEmail
  return (
    <div>
      <StateHeading
        icon={Mail}
        eyebrow="Identity check"
        title="Confirm your email"
        description={
          deliveryEnabled
            ? emailLocked
              ? "Enter the six-digit code we sent to your invited address."
              : "Enter the six-digit code we sent. You can correct the address before requesting another."
            : "Enter the six-digit code printed in the Hearth container logs."
        }
      />
      <form className="mt-6 grid gap-4" onSubmit={onSubmit}>
        <Field label="Email" htmlFor="verification-email">
          <Input
            id="verification-email"
            type="email"
            autoComplete="email"
            value={state.email}
            onChange={(event) => onChange(event.target.value)}
            required
            readOnly={emailLocked}
            className="h-11 bg-card/60 read-only:bg-muted/35 read-only:text-foreground/85"
          />
          <span className="type-meta text-muted-foreground">
            Codes expire in 10 minutes · pending accounts expire after 24 hours
          </span>
        </Field>
        <Field label="Verification code" htmlFor="verification-code">
          <Input
            id="verification-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="000000"
            disabled={changed}
            required={!changed}
            autoFocus={!changed}
            className="h-11 bg-card/60 font-mono tracking-[0.28em]"
          />
        </Field>
        {feedback ? (
          <Notice
            destructive={feedback.tone === "error"}
            icon={feedback.tone === "success" ? Check : undefined}
          >
            {feedback.message}
          </Notice>
        ) : null}
        <Button type="submit" className="h-11" disabled={pending !== null}>
          {pending === "verify" ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Check />
          )}
          {changed ? "Update email & send code" : "Verify email"}
        </Button>
      </form>
      <Button
        type="button"
        variant="ghost"
        className="mt-2 h-10 w-full text-muted-foreground"
        disabled={pending !== null}
        onClick={onResend}
      >
        {pending === "resend" ? (
          <LoaderCircle className="animate-spin" />
        ) : (
          <RefreshCw />
        )}
        {changed ? "Update email" : "Send another code"}
      </Button>
      <button
        type="button"
        className="mt-5 text-xs text-muted-foreground hover:text-foreground"
        onClick={onBack}
      >
        {emailLocked ? "Back" : "Back to sign in"}
      </button>
    </div>
  )
}

function RecoveryPanel({
  deliveryEnabled,
  email,
  error,
  pending,
  onBack,
  onSubmit,
}: {
  deliveryEnabled: boolean
  email: string
  error: string | null
  pending: boolean
  onBack: () => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  return (
    <div>
      <StateHeading
        icon={KeyRound}
        eyebrow="Account recovery"
        title="Choose a new password"
        description={
          deliveryEnabled
            ? `Enter the code sent to ${email}.`
            : `Enter the recovery code for ${email} from the Hearth container logs.`
        }
      />
      {error ? (
        <div className="mt-5">
          <Notice destructive>{error}</Notice>
        </div>
      ) : null}
      <form className="mt-6 grid gap-4" onSubmit={onSubmit}>
        <Field label="Recovery code" htmlFor="recovery-code">
          <Input
            id="recovery-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="000000"
            required
            autoFocus
            className="h-11 bg-card/60 font-mono tracking-[0.28em]"
          />
        </Field>
        <Field label="New password" htmlFor="recovery-password">
          <Input
            id="recovery-password"
            name="password"
            type="password"
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            placeholder="••••••••••••"
            required
            className="h-11 bg-card/60 font-mono"
          />
        </Field>
        <Field label="Confirm password" htmlFor="recovery-confirmation">
          <Input
            id="recovery-confirmation"
            name="confirmPassword"
            type="password"
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            placeholder="••••••••••••"
            required
            className="h-11 bg-card/60 font-mono"
          />
        </Field>
        <Button className="h-11" disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
          Update password
        </Button>
      </form>
      <button
        type="button"
        className="mt-5 text-xs text-muted-foreground hover:text-foreground"
        onClick={onBack}
      >
        Use another email
      </button>
    </div>
  )
}

function RecoveryComplete({ onContinue }: { onContinue: () => void }) {
  return (
    <div>
      <StateHeading
        icon={Check}
        eyebrow="Password updated"
        title="You’re ready to sign in"
        description="Your new password is active and existing Kiln sessions have been revoked."
      />
      <Button className="mt-6 h-11 w-full" onClick={onContinue}>
        Back to sign in
      </Button>
    </div>
  )
}

function StateHeading({
  icon: Icon,
  eyebrow,
  title,
  description,
}: {
  icon: typeof Mail
  eyebrow: string
  title: string
  description: string
}) {
  return (
    <div>
      <div className="grid size-11 place-items-center rounded-xl border border-primary/25 bg-primary/8 text-primary">
        <Icon className="size-5" />
      </div>
      <p className="type-technical-label mt-7 text-primary">{eyebrow}</p>
      <h2 className="mt-2 font-heading text-3xl font-semibold tracking-[-0.045em]">
        {title}
      </h2>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        {description}
      </p>
    </div>
  )
}

function Field({
  label,
  htmlFor,
  action,
  children,
}: {
  label: string
  htmlFor: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={htmlFor} className="type-control-sm text-foreground">
          {label}
        </label>
        {action}
      </div>
      {children}
    </div>
  )
}

function Notice({
  children,
  icon: Icon,
  destructive = false,
}: {
  children: React.ReactNode
  icon?: typeof Check
  destructive?: boolean
}) {
  return (
    <div
      role={destructive ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs leading-5 ${destructive ? "border-destructive/30 bg-destructive/8 text-red-300" : "border-emerald-400/20 bg-emerald-400/7 text-emerald-300"}`}
    >
      {Icon ? <Icon className="mt-0.5 size-3.5 shrink-0" /> : null}
      {children}
    </div>
  )
}

async function signIn(email: string, password: string, redirectPath?: string) {
  sessionStorage.setItem("kiln:auth:return", returnPath(redirectPath))
  const result = await authClient.signIn.email({
    email,
    password,
    callbackURL: destination(redirectPath),
  })
  if (result.error) {
    sessionStorage.removeItem("kiln:auth:return")
    throw new Error(readAuthError(result.error))
  }
  if ("twoFactorRedirect" in result.data && result.data.twoFactorRedirect) {
    window.location.assign("/two-factor")
    return
  }
  sessionStorage.removeItem("kiln:auth:return")
  window.location.assign(destination(redirectPath))
}

function validateNewPassword(password: string, confirmation: string) {
  if (password.length < 12)
    throw new Error("Use at least 12 characters for your password")
  if (password.length > 128)
    throw new Error("Use no more than 128 characters for your password")
  if (password !== confirmation) throw new Error("The passwords do not match")
}

function destination(redirectPath?: string): string {
  return `${window.location.origin}${returnPath(redirectPath)}`
}

function returnPath(redirectPath?: string): string {
  if (!redirectPath?.startsWith("/")) return "/"
  const destinationUrl = new URL(redirectPath, window.location.origin)
  if (destinationUrl.origin !== window.location.origin) return "/"
  return `${destinationUrl.pathname}${destinationUrl.search}${destinationUrl.hash}`
}

function isUnverifiedError(error: {
  code?: string
  message?: string
}): boolean {
  return (
    error.code === "EMAIL_NOT_VERIFIED" ||
    /email.*not.*verified/iu.test(error.message ?? "")
  )
}

function readAuthError(error: {
  message?: string
  statusText?: string
}): string {
  return error.message || error.statusText || "Authentication failed"
}
