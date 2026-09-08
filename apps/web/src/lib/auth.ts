import { createHash } from "node:crypto"

import * as Sentry from "@sentry/tanstackstart-react"
import { passkey } from "@better-auth/passkey"
import { betterAuth } from "better-auth"
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api"
import { admin } from "better-auth/plugins/admin"
import { emailOTP } from "better-auth/plugins/email-otp"
import { twoFactor } from "better-auth/plugins/two-factor"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import type { RowDataPacket } from "mysql2/promise"
import { Resend } from "resend"
import { Effect } from "effect"

import { isAccountVerified } from "@/lib/account-policy"
import { AuthCodeEmail } from "@/emails/auth-code-email"
import { databasePool } from "@/lib/database"
import { databaseTable, databaseTableName } from "@/lib/database-config"
import { parseDisplayName } from "@/lib/display-name"
import {
  betterAuthSecrets,
  betterAuthUrl,
  emailDeliveryConfig,
  kilnPublicUrl,
  parseTrustedOrigins,
  publicSignupEnabled,
} from "@/lib/environment"
import { passwordConfirmation } from "@/lib/password-confirmation"
import { publishRealtimeChange } from "@/lib/realtime-source.server"

const publicUrl = kilnPublicUrl()
const authUrl = betterAuthUrl()
const emailDeliveryEnabled = emailDeliveryConfig() !== null
export const auth = betterAuth({
  appName: "Kiln",
  baseURL: authUrl.origin,
  secrets: betterAuthSecrets(),
  database: databasePool,
  user: {
    modelName: databaseTableName("user"),
    additionalFields: {
      status: { type: "string", defaultValue: "enabled", input: false },
      statusChangedAt: { type: "date", required: false, input: false },
      statusChangedBy: { type: "string", required: false, input: false },
      statusReason: { type: "string", required: false, input: false },
      statusExpiresAt: { type: "date", required: false, input: false },
      emailVerifiedAt: { type: "date", required: false, input: false },
      manuallyVerifiedAt: { type: "date", required: false, input: false },
      manuallyVerifiedBy: { type: "string", required: false, input: false },
      legacyVerificationRecordedAt: {
        type: "date",
        required: false,
        input: false,
      },
    },
  },
  session: {
    modelName: databaseTableName("session"),
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    freshAge: 60 * 60,
  },
  account: { modelName: databaseTableName("account") },
  verification: { modelName: databaseTableName("verification") },
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    requireEmailVerification: false,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 60 * 30,
    revokeSessionsOnPasswordReset: true,
    customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
      ...coreFields,
      role: "user",
      banned: false,
      banReason: null,
      banExpires: null,
      ...additionalFields,
      id,
    }),
  },
  emailVerification: {
    sendOnSignUp: emailDeliveryEnabled,
    autoSignInAfterVerification: false,
    expiresIn: 60 * 10,
  },
  databaseHooks: {
    session: {
      delete: {
        before: async (session) => {
          await recordBetterAuthAuthorizationChange(session.userId, [
            { kind: "login_session", loginSessionId: session.id },
          ])
        },
        after: async (session) => {
          publishRealtimeChange({
            sessionIds: [session.id],
            type: "session.revoked",
          })
          // A second revision closes capabilities issued after the durable
          // pre-delete intent but before Better Auth committed the deletion.
          await recordBetterAuthAuthorizationChange(session.userId, [
            { kind: "login_session", loginSessionId: session.id },
          ])
        },
      },
    },
    user: {
      create: {
        before: async (user) => {
          const name = parseDisplayName(user.name)
          return {
            data: {
              ...user,
              name,
              status: "enabled",
              statusChangedAt: new Date(),
            },
          }
        },
      },
      update: {
        before: async (user) => ({
          data: {
            ...user,
            ...(typeof user.name === "string"
              ? { name: parseDisplayName(user.name) }
              : {}),
            ...(typeof user.email === "string"
              ? {
                  emailVerifiedAt: null,
                  manuallyVerifiedAt: null,
                  manuallyVerifiedBy: null,
                  legacyVerificationRecordedAt: null,
                }
              : {}),
            ...(user.emailVerified === true
              ? { emailVerifiedAt: new Date() }
              : {}),
            ...(user.emailVerified === false ? { emailVerifiedAt: null } : {}),
          },
        }),
        after: async (user, context) => {
          await recordBetterAuthAuthorizationChange(user.id, [
            { kind: "subject_relay" },
          ])
          if (
            context &&
            [
              "/email-otp/verify-email",
              "/verify-email",
              "/email-otp/change-email",
            ].includes(context.path ?? "")
          ) {
            await databasePool.execute(
              `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata)
               VALUES (?, 'account.email-verified', ?)`,
              [user.id, JSON.stringify({ actorId: user.id, email: user.email })]
            )
          }
          publishRealtimeChange({
            type: "access.changed",
            reauthenticate: true,
            userIds: [user.id],
          })
        },
      },
      delete: {
        before: async (user) => {
          await recordBetterAuthAuthorizationChange(user.id, [
            { kind: "subject_relay" },
          ])
        },
        after: async (user) => {
          await recordBetterAuthAuthorizationChange(user.id, [
            { kind: "subject_relay" },
          ])
        },
      },
    },
  },
  rateLimit: {
    modelName: databaseTableName("rateLimit"),
    enabled: true,
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 3 },
      "/email-otp/send-verification-otp": { window: 60, max: 3 },
      "/email-otp/request-password-reset": { window: 60, max: 3 },
      "/email-otp/reset-password": { window: 60, max: 5 },
      "/password-confirmation/confirm": { window: 60, max: 5 },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      // Kiln owns administrative policy and preserves disabled users' login
      // sessions. Better Auth admin endpoints bypass those transactions.
      if (context.path.startsWith("/admin/")) {
        throw new APIError("FORBIDDEN", {
          message: "Use Kiln user management.",
        })
      }

      const onboardingPaths = new Set([
        "/get-session",
        "/sign-out",
        "/sign-in/email",
        "/sign-up/email",
        "/verify-email",
        "/send-verification-email",
        "/email-otp/send-verification-otp",
        "/email-otp/verify-email",
        "/email-otp/request-password-reset",
        "/email-otp/reset-password",
        "/request-password-reset",
        "/reset-password",
      ])
      if (!onboardingPaths.has(context.path)) {
        const session = await getSessionFromCtx(context)
        if (
          session &&
          !isAccountVerified({
            emailVerifiedAt:
              (session.user.emailVerifiedAt as Date | null) ?? null,
            manuallyVerifiedAt:
              (session.user.manuallyVerifiedAt as Date | null) ?? null,
            legacyVerificationRecordedAt:
              (session.user.legacyVerificationRecordedAt as Date | null) ??
              null,
          })
        ) {
          throw new APIError("FORBIDDEN", {
            message: "Account verification required.",
          })
        }
      }

      if (context.path !== "/sign-up/email") return

      const body = context.body as { email?: unknown }
      if (typeof body.email !== "string") return
      if (publicSignupEnabled()) return

      const normalizedEmail = body.email.trim().toLowerCase()
      const [pendingInvitations] = await databasePool.query<
        Array<{ id: string } & RowDataPacket>
      >(
        `SELECT id
           FROM ${databaseTable("invitation")}
          WHERE email = ?
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > CURRENT_TIMESTAMP(3)
          LIMIT 1`,
        [normalizedEmail]
      )
      if (!pendingInvitations.length) {
        throw new APIError("FORBIDDEN", {
          message: "New account registration is disabled.",
        })
      }
    }),
  },
  trustedOrigins: parseTrustedOrigins(publicUrl.origin, authUrl.origin),
  advanced: {
    cookiePrefix: "kiln",
    useSecureCookies: authUrl.protocol === "https:",
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
    },
  },
  plugins: [
    admin({ defaultRole: "user", adminRoles: ["admin"] }),
    emailOTP({
      changeEmail: { enabled: true },
      disableSignUp: true,
      expiresIn: 60 * 10,
      otpLength: 6,
      overrideDefaultEmailVerification: true,
      async sendVerificationOTP({ email, otp, type }) {
        const delivery = emailDeliveryConfig()
        if (!delivery) {
          throw new APIError("BAD_REQUEST", {
            message:
              "Email delivery is unavailable. Ask an administrator to verify your account.",
          })
        }

        const fingerprint = createHash("sha256")
          .update(`${email.toLowerCase()}:${type}:${otp}`)
          .digest("hex")
          .slice(0, 20)
        const resend = new Resend(delivery.apiKey)
        void resend.emails
          .send(
            {
              from: delivery.from,
              to: [email],
              subject:
                type === "forget-password"
                  ? "Reset your Kiln password"
                  : "Your Kiln verification code",
              react: AuthCodeEmail({ code: otp, purpose: type }),
            },
            { idempotencyKey: `auth-code/${type}/${fingerprint}` }
          )
          .then(({ error }) => {
            if (error)
              console.error("Could not send Kiln authentication code", error)
          })
      },
    }),
    twoFactor({
      twoFactorTable: databaseTableName("twoFactor"),
      issuer: "Kiln",
      totpOptions: { digits: 6, period: 30 },
      backupCodeOptions: {
        amount: 10,
        length: 10,
        storeBackupCodes: "encrypted",
      },
      twoFactorCookieMaxAge: 60 * 10,
      trustDeviceMaxAge: 60 * 60 * 24 * 30,
    }),
    passkey({
      rpID: publicUrl.hostname,
      rpName: "Kiln",
      origin: publicUrl.origin,
      schema: {
        passkey: { modelName: databaseTableName("passkey") },
      },
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    }),
    passwordConfirmation(),
    tanstackStartCookies(),
  ],
})

export type AuthSession = typeof auth.$Infer.Session

export { publicSignupEnabled }

async function recordBetterAuthAuthorizationChange(
  userId: string,
  scopes: ReadonlyArray<
    | { kind: "login_session"; loginSessionId: string }
    | { kind: "subject_relay" }
  >
): Promise<void> {
  await Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        const { recordAuthorizationChange } =
          await import("@/lib/authorization-delivery")
        await recordAuthorizationChange({ scopes, userId })
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.tapError((cause) =>
        Effect.sync(() => {
          Sentry.captureException(cause, {
            tags: { component: "better-auth-authorization-revision" },
          })
        })
      )
    )
  )
}
