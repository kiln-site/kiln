import { Effect } from "effect"
import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise"
import { z } from "zod"

import { auth } from "@/lib/auth"
import { databasePool } from "@/lib/database"
import { databaseTable, databaseTablePrefix } from "@/lib/database-config"
import {
  displayNameFromEmail,
  parseDisplayName,
  resolveDisplayName,
} from "@/lib/display-name"
import { emailDeliveryConfig, publicSignupEnabled } from "@/lib/environment"

const emailSchema = z.email().transform((value) => value.trim().toLowerCase())
const FIRST_USER_LOCK = `${databaseTablePrefix()}:first-user`

interface UserCountRow extends RowDataPacket {
  user_count: number
}

interface PendingCredentialRow extends RowDataPacket {
  email: string
  emailVerified: number
  id: string
  name: string
  password: string | null
  role: string | null
}

let configuredSuperUserPromise: Promise<void> | null = null

export async function ensureConfiguredSuperUser(): Promise<void> {
  const email = process.env.KILN_SUPER_USER_EMAIL?.trim()
  const password = process.env.KILN_SUPER_USER_PASSWORD
  if (!email && !password) return
  if (!email || !password) {
    throw new Error(
      "KILN_SUPER_USER_EMAIL and KILN_SUPER_USER_PASSWORD must be supplied together"
    )
  }
  if (password.length < 12 || password.length > 128) {
    throw new Error("KILN_SUPER_USER_PASSWORD must contain 12–128 characters")
  }

  configuredSuperUserPromise ??= createFirstUser({
    email: emailSchema.parse(email),
    password,
    verified: true,
  }).then(() => undefined)
  await configuredSuperUserPromise
}

export async function installationState(): Promise<{
  emailDeliveryEnabled: boolean
  setupRequired: boolean
}> {
  await ensureConfiguredSuperUser()
  const [rows] = await databasePool.query<Array<UserCountRow>>(
    `SELECT COUNT(*) AS user_count FROM ${databaseTable("user")}`
  )
  return {
    emailDeliveryEnabled: emailDeliveryConfig() !== null,
    setupRequired: Number(rows[0]?.user_count ?? 0) === 0,
  }
}

export async function createInitialAdministrator(input: {
  displayName: string
  email: string
  password: string
}): Promise<{ email: string; verificationRequired: boolean }> {
  const email = emailSchema.parse(input.email)
  const verificationRequired = emailDeliveryConfig() !== null
  const created = await createFirstUser({
    displayName: parseDisplayName(input.displayName),
    email,
    password: input.password,
    verified: !verificationRequired,
  })
  if (!created)
    throw new Error("Kiln has already been set up. Sign in instead.")
  if (verificationRequired) await sendEmailVerificationCode(email)
  return { email, verificationRequired }
}

export async function replacePendingAccountEmail(input: {
  currentEmail: string
  nextEmail: string
  password: string
}): Promise<{ email: string }> {
  const currentEmail = emailSchema.parse(input.currentEmail)
  const nextEmail = emailSchema.parse(input.nextEmail)
  if (currentEmail === nextEmail) {
    await sendEmailVerificationCode(currentEmail)
    return { email: currentEmail }
  }

  await withFirstUserLock(
    "Account setup is busy. Try again in a moment.",
    async (connection) => {
      const [rows] = await connection.query<Array<PendingCredentialRow>>(
        `SELECT auth_user.id, auth_user.email, auth_user.emailVerified,
              auth_user.name,
              auth_user.role, auth_account.password
         FROM ${databaseTable("user")} AS auth_user
         JOIN ${databaseTable("account")} AS auth_account
           ON auth_account.userId = auth_user.id
          AND auth_account.providerId = 'credential'
        WHERE auth_user.email = ?
        LIMIT 1`,
        [currentEmail]
      )
      const pending = rows.at(0)
      if (!pending || pending.emailVerified) {
        throw new Error("This pending account can no longer be changed.")
      }
      const context = await auth.$context
      const ownsAccount = Boolean(
        pending.password &&
        (await context.password.verify({
          password: input.password,
          hash: pending.password,
        }))
      )
      if (!ownsAccount) throw new Error("The account password did not match.")

      const isInitialAdmin = pending.role?.split(",").includes("admin") ?? false
      if (!isInitialAdmin && !(await signupAllowedForEmail(nextEmail))) {
        throw new Error("This invitation is only valid for its original email.")
      }

      const [existingRows] = await connection.query<Array<RowDataPacket>>(
        `SELECT id FROM ${databaseTable("user")} WHERE email = ? LIMIT 1`,
        [nextEmail]
      )
      if (existingRows.length)
        throw new Error("That email address is already in use.")

      await context.internalAdapter.deleteUser(pending.id)
      await createCredentialUser({
        displayName: resolveDisplayName(pending.name, pending.email),
        email: nextEmail,
        password: input.password,
        role: isInitialAdmin ? "admin" : "user",
        verified: false,
      })
    }
  )

  await sendEmailVerificationCode(nextEmail)
  return { email: nextEmail }
}

async function createFirstUser(input: {
  displayName?: string
  email: string
  password: string
  verified: boolean
}): Promise<boolean> {
  return withFirstUserLock(
    "Initial setup is busy. Try again in a moment.",
    async (connection) => {
      const [countRows] = await connection.query<Array<UserCountRow>>(
        `SELECT COUNT(*) AS user_count FROM ${databaseTable("user")}`
      )
      if (Number(countRows[0]?.user_count ?? 0) > 0) return false

      await createCredentialUser({ ...input, role: "admin" })
      return true
    }
  )
}

async function createCredentialUser(input: {
  displayName?: string
  email: string
  password: string
  role: "admin" | "user"
  verified: boolean
}): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* promiseEffect(() => auth.$context)
      const password = yield* promiseEffect(() =>
        context.password.hash(input.password)
      )
      const user = yield* promiseEffect(() =>
        context.internalAdapter.createUser({
          email: input.email,
          emailVerified: input.verified,
          name: input.displayName
            ? parseDisplayName(input.displayName)
            : displayNameFromEmail(input.email),
          role: input.role,
        })
      )
      yield* Effect.gen(function* () {
        yield* promiseEffect(() =>
          context.internalAdapter.linkAccount({
            accountId: user.id,
            password,
            providerId: "credential",
            userId: user.id,
          })
        )
        yield* promiseEffect(() =>
          databasePool.execute<ResultSetHeader>(
            `UPDATE ${databaseTable("user")} SET emailVerified = ?, role = ? WHERE id = ?`,
            [input.verified, input.role, user.id]
          )
        )
      }).pipe(
        Effect.catch((cause) =>
          promiseEffect(() => context.internalAdapter.deleteUser(user.id)).pipe(
            Effect.option,
            Effect.andThen(Effect.fail(cause))
          )
        )
      )
    })
  )
}

function withFirstUserLock<TResult>(
  busyMessage: string,
  use: (connection: PoolConnection) => Promise<TResult>
): Promise<TResult> {
  return Effect.runPromise(
    Effect.acquireUseRelease(
      promiseEffect(async () => ({
        connection: await databasePool.getConnection(),
        locked: false,
      })),
      (resource) =>
        Effect.gen(function* () {
          const [rows] = yield* promiseEffect(() =>
            resource.connection.query<Array<RowDataPacket>>(
              "SELECT GET_LOCK(?, 10) AS acquired",
              [FIRST_USER_LOCK]
            )
          )
          resource.locked = Number(rows[0]?.acquired ?? 0) === 1
          if (!resource.locked)
            return yield* Effect.fail(new Error(busyMessage))
          return yield* promiseEffect(() => use(resource.connection))
        }),
      (resource) =>
        (resource.locked
          ? promiseEffect(() =>
              resource.connection.query("SELECT RELEASE_LOCK(?)", [
                FIRST_USER_LOCK,
              ])
            )
          : Effect.succeed(undefined)
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              resource.connection.release()
            })
          )
        )
    ).pipe(Effect.uninterruptible)
  )
}

function promiseEffect<TResult>(
  run: () => PromiseLike<TResult>
): Effect.Effect<TResult, unknown> {
  return Effect.tryPromise({ try: run, catch: (cause) => cause })
}

async function signupAllowedForEmail(email: string): Promise<boolean> {
  if (publicSignupEnabled()) return true
  const [rows] = await databasePool.query<Array<RowDataPacket>>(
    `SELECT id FROM ${databaseTable("invitation")}
      WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP(3)
      LIMIT 1`,
    [email]
  )
  return rows.length > 0
}

async function sendEmailVerificationCode(email: string): Promise<void> {
  await auth.api.sendVerificationOTP({
    body: { email, type: "email-verification" },
  })
}
