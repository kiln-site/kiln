import { createHash, randomBytes, randomUUID } from "node:crypto"

import type {
  CliAccessDuration,
  CliAccessMode,
  CliDeviceCodeResponse,
  CliDeviceTokenResponse,
} from "@workspace/contracts"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"
import { Database } from "@/effect/database"
import { CliAccessError } from "@/effect/errors"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"
import {
  advanceAuthorizationRevisionEffect,
  enabledRelayTargetsEffect,
} from "@/lib/authorization-revision"
import { betterAuthSecrets, cliDefaultAccessDays } from "@/lib/environment"
import type { PlatformRole } from "@/lib/permissions"

const DEVICE_CODE_TTL_MS = 10 * 60_000
const DEVICE_POLL_INTERVAL_SECONDS = 3
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const TOKEN_ENCRYPTION_PURPOSE = "cli-device-access-token"

interface CliDeviceRow extends RowDataPacket {
  access_mode: CliAccessMode | null
  authorized_at: Date | null
  client_name: string
  credential_expires_at: Date | null
  credential_id: string | null
  expires_at: Date
  last_polled_at: Date | null
  status: "approved" | "denied" | "pending"
  token_ciphertext: string | null
  user_id: string | null
}

interface CliCredentialRow extends RowDataPacket {
  access_mode: CliAccessMode
  created_at: Date
  expires_at: Date | null
  id: string
  last_used_at: Date | null
  name: string
  revoked_at: Date | null
  user_id: string
}

interface CliPrincipalRow extends CliCredentialRow {
  banned: number | boolean | null
  email: string
  email_verified: number | boolean
  role: string | null
  two_factor_enabled: number | boolean | null
  user_name: string
}

export interface CliPrincipal {
  credentialId: string
  mode: CliAccessMode
  user: AuthenticatedUser
}

export interface CliCredentialSummary {
  active: boolean
  createdAt: string
  expiresAt: string | null
  id: string
  lastUsedAt: string | null
  mode: CliAccessMode
  name: string
  revokedAt: string | null
}

export interface CliAuthorizationRequest {
  expiresAt: string
  name: string
  userCode: string
}

export function cliPlatformRole(role: string | null): PlatformRole {
  return role === "admin" || role === "relay_creator" ? role : "user"
}

export const issueCliDeviceCodeEffect = Effect.fn("cli.device.issue")(
  function* (input: {
    baseUrl: URL
    ipAddress: string | null
    name: string
    userAgent: string | null
  }) {
    const database = yield* Database
    const recent = yield* database.queryRows<{ total: number } & RowDataPacket>(
      "cli.device.rateLimit",
      `SELECT COUNT(*) AS total
         FROM ${databaseTable("auth_audit")}
        WHERE event = 'cli.device.requested'
          AND ip_address <=> ?
          AND created_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 MINUTE)`,
      [input.ipAddress]
    )
    if (Number(recent[0]?.total ?? 0) >= 10) {
      return yield* CliAccessError.make({
        code: "rate_limited",
        message: "Too many CLI authorization requests. Try again shortly.",
        retryable: true,
      })
    }

    const deviceCode = randomBytes(32).toString("base64url")
    const userCode = generateUserCode()
    const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MS)
    yield* database.transaction("cli.device.issue", (transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("cli_device")}
            WHERE expires_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY)`,
          []
        )
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("cli_device")}
             (id, device_code_hash, user_code_hash, client_name, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            digest(deviceCode),
            digest(normalizeUserCode(userCode)),
            input.name,
            expiresAt,
          ]
        )
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("auth_audit")}
             (user_id, event, ip_address, user_agent, metadata)
           VALUES (NULL, 'cli.device.requested', ?, ?, ?)`,
          [
            input.ipAddress,
            input.userAgent,
            JSON.stringify({ name: input.name }),
          ]
        )
      })
    )

    const verificationUri = new URL("/cli/authorize", input.baseUrl)
    const verificationUriComplete = new URL(verificationUri)
    verificationUriComplete.searchParams.set("code", userCode)
    return {
      deviceCode,
      expiresAt: expiresAt.toISOString(),
      interval: DEVICE_POLL_INTERVAL_SECONDS,
      userCode,
      verificationUri: verificationUri.toString(),
      verificationUriComplete: verificationUriComplete.toString(),
    } satisfies CliDeviceCodeResponse
  }
)

export const inspectCliAuthorizationEffect = Effect.fn("cli.device.inspect")(
  function* (userCode: string) {
    const database = yield* Database
    const normalized = normalizeUserCode(userCode)
    if (!isUserCode(normalized)) {
      return yield* invalidGrant("The CLI authorization code is invalid.")
    }
    const rows = yield* database.queryRows<CliDeviceRow>(
      "cli.device.inspect",
      `SELECT client_name, expires_at, status, access_mode, authorized_at,
            credential_expires_at, credential_id, last_polled_at,
            token_ciphertext, user_id
       FROM ${databaseTable("cli_device")}
      WHERE user_code_hash = ?
      LIMIT 1`,
      [digest(normalized)]
    )
    const request = rows[0]
    if (!request || request.expires_at.getTime() <= Date.now()) {
      return yield* invalidGrant("The CLI authorization code has expired.")
    }
    if (request.status !== "pending") {
      return yield* CliAccessError.make({
        code: "conflict",
        message: `This CLI authorization request was already ${request.status}.`,
        retryable: false,
      })
    }
    return {
      expiresAt: request.expires_at.toISOString(),
      name: request.client_name,
      userCode: formatUserCode(normalized),
    } satisfies CliAuthorizationRequest
  }
)

export const approveCliAuthorizationEffect = Effect.fn("cli.device.approve")(
  function* (input: {
    duration: CliAccessDuration
    mode: CliAccessMode
    user: AuthenticatedUser
    userCode: string
  }) {
    if (input.user.isDevelopmentBypass) {
      return yield* CliAccessError.make({
        code: "forbidden",
        message: "Sign in with a persisted account before linking a CLI.",
        retryable: false,
      })
    }
    if (input.duration === "indefinite" && input.mode !== "read_only") {
      return yield* CliAccessError.make({
        code: "invalid_request",
        message: "Indefinite CLI access must be read-only.",
        retryable: false,
      })
    }
    const normalized = normalizeUserCode(input.userCode)
    if (!isUserCode(normalized)) {
      return yield* invalidGrant("The CLI authorization code is invalid.")
    }

    const database = yield* Database
    const credentialId = randomUUID()
    const accessToken = `kiln_cli_${randomBytes(32).toString("base64url")}`
    const credentialExpiresAt = expirationForDuration(input.duration)
    yield* database.transaction("cli.device.approve", (transaction) =>
      Effect.gen(function* () {
        const rows = yield* transaction.queryRows<CliDeviceRow>(
          `SELECT client_name, expires_at, status, access_mode, authorized_at,
                credential_expires_at, credential_id, last_polled_at,
                token_ciphertext, user_id
           FROM ${databaseTable("cli_device")}
          WHERE user_code_hash = ?
          LIMIT 1
          FOR UPDATE`,
          [digest(normalized)]
        )
        const request = rows[0]
        if (!request || request.expires_at.getTime() <= Date.now()) {
          return yield* invalidGrant("The CLI authorization code has expired.")
        }
        if (request.status !== "pending") {
          return yield* CliAccessError.make({
            code: "conflict",
            message: `This CLI authorization request was already ${request.status}.`,
            retryable: false,
          })
        }

        yield* transaction.execute(
          `INSERT INTO ${databaseTable("cli_credential")}
           (id, user_id, name, token_hash, access_mode, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
          [
            credentialId,
            input.user.id,
            request.client_name,
            digest(accessToken),
            input.mode,
            credentialExpiresAt,
          ]
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("cli_device")}
            SET status = 'approved', user_id = ?, credential_id = ?,
                token_ciphertext = ?, access_mode = ?,
                credential_expires_at = ?, authorized_at = CURRENT_TIMESTAMP(3)
          WHERE user_code_hash = ?`,
          [
            input.user.id,
            credentialId,
            encryptWithKeyring(
              accessToken,
              betterAuthSecrets(),
              TOKEN_ENCRYPTION_PURPOSE
            ),
            input.mode,
            credentialExpiresAt,
            digest(normalized),
          ]
        )
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("auth_audit")}
           (user_id, event, metadata)
         VALUES (?, 'cli.credential.created', ?)`,
          [
            input.user.id,
            JSON.stringify({
              credentialId,
              duration: input.duration,
              mode: input.mode,
              name: request.client_name,
            }),
          ]
        )
      })
    )
    return { approved: true as const, credentialId }
  }
)

export const denyCliAuthorizationEffect = Effect.fn("cli.device.deny")(
  function* (input: { user: AuthenticatedUser; userCode: string }) {
    if (input.user.isDevelopmentBypass) {
      return yield* CliAccessError.make({
        code: "forbidden",
        message: "Sign in with a persisted account before managing CLIs.",
        retryable: false,
      })
    }
    const normalized = normalizeUserCode(input.userCode)
    if (!isUserCode(normalized)) {
      return yield* invalidGrant("The CLI authorization code is invalid.")
    }
    const database = yield* Database
    const result = yield* database.execute(
      "cli.device.deny",
      `UPDATE ${databaseTable("cli_device")}
          SET status = 'denied', user_id = ?, authorized_at = CURRENT_TIMESTAMP(3)
        WHERE user_code_hash = ?
          AND status = 'pending'
          AND expires_at > CURRENT_TIMESTAMP(3)`,
      [input.user.id, digest(normalized)]
    )
    if (result.affectedRows !== 1) {
      return yield* invalidGrant(
        "The CLI authorization code is invalid or no longer pending."
      )
    }
    return { denied: true as const }
  }
)

export const pollCliDeviceTokenEffect = Effect.fn("cli.device.poll")(function* (
  deviceCode: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<CliDeviceRow>(
    "cli.device.poll",
    `SELECT client_name, expires_at, status, access_mode, authorized_at,
              credential_expires_at, credential_id, last_polled_at,
              token_ciphertext, user_id
         FROM ${databaseTable("cli_device")}
        WHERE device_code_hash = ?
        LIMIT 1`,
    [digest(deviceCode)]
  )
  const request = rows[0]
  if (!request) return yield* invalidGrant("The device code is invalid.")
  if (request.expires_at.getTime() <= Date.now()) {
    return yield* CliAccessError.make({
      code: "expired_token",
      message: "The CLI authorization request expired.",
      retryable: false,
    })
  }
  if (
    request.last_polled_at &&
    Date.now() - request.last_polled_at.getTime() <
      DEVICE_POLL_INTERVAL_SECONDS * 1_000 - 250
  ) {
    return yield* CliAccessError.make({
      code: "slow_down",
      message: "The CLI is polling too quickly.",
      retryable: true,
    })
  }
  yield* database.execute(
    "cli.device.touch",
    `UPDATE ${databaseTable("cli_device")}
          SET last_polled_at = CURRENT_TIMESTAMP(3)
        WHERE device_code_hash = ?`,
    [digest(deviceCode)]
  )
  if (request.status === "pending") {
    return yield* CliAccessError.make({
      code: "authorization_pending",
      message: "Waiting for browser authorization.",
      retryable: true,
    })
  }
  if (request.status === "denied") {
    return yield* CliAccessError.make({
      code: "access_denied",
      message: "CLI access was denied.",
      retryable: false,
    })
  }
  if (!request.credential_id || !request.access_mode) {
    return yield* CliAccessError.make({
      code: "unexpected_error",
      message: "The approved CLI credential is incomplete.",
      retryable: false,
    })
  }
  if (!request.token_ciphertext) {
    return yield* invalidGrant(
      "This CLI credential was already delivered to the requesting device."
    )
  }
  const tokenCiphertext = request.token_ciphertext
  const accessToken = yield* Effect.try({
    try: () =>
      decryptWithKeyring(
        tokenCiphertext,
        betterAuthSecrets(),
        TOKEN_ENCRYPTION_PURPOSE
      ).plaintext,
    catch: (cause) =>
      CliAccessError.make({
        code: "unexpected_error",
        message: "The CLI credential could not be delivered.",
        retryable: false,
        cause,
      }),
  })
  const consumed = yield* database.execute(
    "cli.device.consume",
    `UPDATE ${databaseTable("cli_device")}
        SET token_ciphertext = NULL
      WHERE device_code_hash = ?
        AND token_ciphertext = ?`,
    [digest(deviceCode), tokenCiphertext]
  )
  if (consumed.affectedRows !== 1) {
    return yield* invalidGrant(
      "This CLI credential was already delivered to the requesting device."
    )
  }
  return {
    accessToken,
    credential: {
      expiresAt: request.credential_expires_at?.toISOString() ?? null,
      id: request.credential_id,
      mode: request.access_mode,
      name: request.client_name,
    },
    tokenType: "Bearer" as const,
  } satisfies CliDeviceTokenResponse
})

export const authenticateCliTokenEffect = Effect.fn("cli.token.authenticate")(
  function* (accessToken: string) {
    if (!accessToken.startsWith("kiln_cli_") || accessToken.length > 256) {
      return yield* authenticationRequired()
    }
    const database = yield* Database
    const rows = yield* database.queryRows<CliPrincipalRow>(
      "cli.token.authenticate",
      `SELECT credential.id, credential.user_id, credential.name,
              credential.access_mode, credential.expires_at,
              credential.last_used_at, credential.revoked_at,
              credential.created_at, user.email, user.name AS user_name,
              user.emailVerified AS email_verified, user.role, user.banned,
              user.twoFactorEnabled AS two_factor_enabled
         FROM ${databaseTable("cli_credential")} credential
         JOIN ${databaseTable("user")} user ON user.id = credential.user_id
        WHERE credential.token_hash = ?
          AND credential.revoked_at IS NULL
          AND (credential.expires_at IS NULL OR credential.expires_at > CURRENT_TIMESTAMP(3))
        LIMIT 1`,
      [digest(accessToken)]
    )
    const credential = rows[0]
    if (!credential || Boolean(credential.banned)) {
      return yield* authenticationRequired()
    }
    yield* database.execute(
      "cli.token.touch",
      `UPDATE ${databaseTable("cli_credential")}
          SET last_used_at = CURRENT_TIMESTAMP(3)
        WHERE id = ?
          AND (last_used_at IS NULL OR last_used_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 5 MINUTE))`,
      [credential.id]
    )
    return {
      credentialId: credential.id,
      mode: credential.access_mode,
      user: {
        email: credential.email,
        emailVerified: Boolean(credential.email_verified),
        id: credential.user_id,
        isDevelopmentBypass: false,
        name: credential.user_name,
        role: cliPlatformRole(credential.role),
        twoFactorEnabled: Boolean(credential.two_factor_enabled),
      },
    } satisfies CliPrincipal
  }
)

export const listCliCredentialsEffect = Effect.fn("cli.credentials.list")(
  function* (user: AuthenticatedUser) {
    if (user.isDevelopmentBypass) return []
    const database = yield* Database
    const rows = yield* database.queryRows<CliCredentialRow>(
      "cli.credentials.list",
      `SELECT id, user_id, name, access_mode, expires_at, last_used_at,
              revoked_at, created_at
         FROM ${databaseTable("cli_credential")}
        WHERE user_id = ?
        ORDER BY created_at DESC`,
      [user.id]
    )
    return rows.map(cliCredentialSummary)
  }
)

export const revokeCliCredentialEffect = Effect.fn("cli.credentials.revoke")(
  function* (input: { credentialId: string; user: AuthenticatedUser }) {
    if (input.user.isDevelopmentBypass) {
      return yield* CliAccessError.make({
        code: "forbidden",
        message: "Development bypass does not own CLI credentials.",
        retryable: false,
      })
    }
    const database = yield* Database
    const result = yield* database.transaction(
      "cli.credentials.revoke",
      (transaction) =>
        Effect.gen(function* () {
          const updated = yield* transaction.execute(
            `UPDATE ${databaseTable("cli_credential")}
                SET revoked_at = CURRENT_TIMESTAMP(3)
              WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
            [input.credentialId, input.user.id]
          )
          if (updated.affectedRows === 1) {
            yield* transaction.execute(
              `INSERT INTO ${databaseTable("auth_audit")}
                 (user_id, event, metadata)
               VALUES (?, 'cli.credential.revoked', ?)`,
              [
                input.user.id,
                JSON.stringify({ credentialId: input.credentialId }),
              ]
            )
            const targets = yield* enabledRelayTargetsEffect(transaction, {
              kind: "login_session",
              loginSessionId: `cli:${input.credentialId}`,
            })
            const change = yield* advanceAuthorizationRevisionEffect(
              transaction,
              {
                targets,
                userId: input.user.id,
              }
            )
            return { affectedRows: updated.affectedRows, change }
          }
          return { affectedRows: updated.affectedRows, change: null }
        })
    )
    if (result.affectedRows !== 1) {
      return yield* CliAccessError.make({
        code: "not_found",
        message: "The CLI credential was not found or is already unlinked.",
        retryable: false,
      })
    }
    if (result.change) {
      yield* Effect.promise(async () => {
        const { wakeAuthorizationDelivery } =
          await import("@/lib/authorization-delivery")
        for (const relayId of result.change.relayIds) {
          wakeAuthorizationDelivery(relayId)
        }
      })
    }
    return { revoked: true as const }
  }
)

export function requireCliWrite(principal: CliPrincipal) {
  return principal.mode === "read_only"
    ? Effect.fail(
        CliAccessError.make({
          code: "forbidden",
          message: "This CLI is linked with read-only access.",
          retryable: false,
        })
      )
    : Effect.void
}

export function cliRelaySubject(principal: CliPrincipal): string {
  return `cli/${principal.credentialId}/${principal.user.id}`
}

export function bearerToken(headers: Headers): string | null {
  const authorization = headers.get("authorization")
  if (!authorization) return null
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization)
  return match?.[1] ?? null
}

function cliCredentialSummary(row: CliCredentialRow): CliCredentialSummary {
  return {
    active:
      row.revoked_at === null &&
      (row.expires_at === null || row.expires_at.getTime() > Date.now()),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    id: row.id,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    mode: row.access_mode,
    name: row.name,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  }
}

function expirationForDuration(duration: CliAccessDuration): Date | null {
  if (duration === "indefinite") return null
  const durationMs =
    duration === "1h"
      ? 60 * 60_000
      : duration === "1d"
        ? 24 * 60 * 60_000
        : duration === "1w"
          ? 7 * 24 * 60 * 60_000
          : cliDefaultAccessDays() * 24 * 60 * 60_000
  return new Date(Date.now() + durationMs)
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function normalizeUserCode(value: string): string {
  return value.trim().replace(/-/gu, "").toUpperCase()
}

function isUserCode(value: string): boolean {
  return /^[A-Z2-9]{8}$/u.test(value)
}

function formatUserCode(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4)}`
}

function generateUserCode(): string {
  const bytes = randomBytes(8)
  const code = Array.from(bytes, (byte) =>
    USER_CODE_ALPHABET.charAt(byte % USER_CODE_ALPHABET.length)
  ).join("")
  return formatUserCode(code)
}

function invalidGrant(message: string) {
  return CliAccessError.make({
    code: "invalid_grant",
    message,
    retryable: false,
  })
}

function authenticationRequired() {
  return CliAccessError.make({
    code: "authentication_required",
    message: "Run `kiln login` or provide KILN_TOKEN.",
    retryable: false,
  })
}
