import { createHash } from "node:crypto"

import { passkey } from "@better-auth/passkey"
import { betterAuth } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { admin } from "better-auth/plugins/admin"
import { emailOTP } from "better-auth/plugins/email-otp"
import { twoFactor } from "better-auth/plugins/two-factor"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import type { RowDataPacket } from "mysql2/promise"
import { Resend } from "resend"

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

const publicUrl = kilnPublicUrl()
const authUrl = betterAuthUrl()
const emailDeliveryEnabled = emailDeliveryConfig() !== null
const UNVERIFIED_ACCOUNT_TTL_MS = 1000 * 60 * 60 * 24

type PendingUser = {
  createdAt: Date
  email: string
  emailVerified: boolean
  id: string
}

export const auth = betterAuth({
  appName: "Kiln",
  baseURL: authUrl.origin,
  secrets: betterAuthSecrets(),
  database: databasePool,
  user: { modelName: databaseTableName("user") },
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
    requireEmailVerification: emailDeliveryEnabled,
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
    user: {
      create: {
        before: async (user) => {
          const name = parseDisplayName(user.name)
          return {
            data: emailDeliveryEnabled
              ? { ...user, name }
              : { ...user, name, emailVerified: true },
          }
        },
      },
      update: {
        before: async (user) => ({
          data:
            typeof user.name === "string"
              ? { ...user, name: parseDisplayName(user.name) }
              : user,
        }),
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
      const cleanupPaths = new Set([
        "/email-otp/request-password-reset",
        "/email-otp/send-verification-otp",
        "/email-otp/verify-email",
        "/sign-in/email",
        "/sign-up/email",
      ])
      if (cleanupPaths.has(context.path)) {
        const cutoff = new Date(Date.now() - UNVERIFIED_ACCOUNT_TTL_MS)
        const expiredUsers =
          await context.context.adapter.findMany<PendingUser>({
            model: "user",
            where: [
              { field: "emailVerified", value: false },
              { field: "createdAt", value: cutoff, operator: "lt" },
            ],
            limit: 100,
          })
        for (const user of expiredUsers) {
          await context.context.internalAdapter.deleteUser(user.id)
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
          console.info(
            `[Kiln auth] ${type} code for ${email.toLowerCase()}: ${otp}`
          )
          return
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
