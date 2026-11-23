import { relayRecoveryCodeSchema } from "@workspace/contracts"
import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schema } from "effect"

import { Database } from "@/effect/database"
import { promiseEffect, recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { isPlatformAdmin } from "@/lib/access-control"
import { requireTwoFactorCodeEffect } from "@/lib/auth-two-factor"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"
import type {
  RecoveryCodeReveal,
  RecoveryCodeStatus,
} from "@/lib/recovery-code"
import { exclusive } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"

// Kiln's recovery code, which opens its platform backups and, with one,
// restores Kiln on a new machine, and who said they saved it. The code itself
// stays on the Relay hosting Kiln and is read from it each time it's shown;
// Hearth never stores it, and no journal or audit keeps it.
//
// Showing it needs a fresh second factor, but for the administrator setting
// Kiln up, who couldn't have turned one on yet: while theirs is the only
// account, it's new, and nobody has said they saved the code.

const recordId = "00000000-0000-4000-8000-000000000006"
const recordKey = "recovery-code"
/** The record's lane: a reveal reads and marks it, one at a time. */
const recoveryCodeKey = "recovery-code"

const RecoveryRecord = Schema.Struct({
  savedAt: Schema.NullOr(Schema.Number),
  savedBy: Schema.NullOr(Schema.String),
})
type RecoveryRecord = typeof RecoveryRecord.Type

const emptyRecord: RecoveryRecord = {
  savedAt: null,
  savedBy: null,
}

/** How long someone setting Kiln up can see it without a second factor. */
const setupWindowMs = 30 * 60 * 1000

const showsWithoutCode = Effect.fnUntraced(function* (
  record: RecoveryRecord,
  userId: string
) {
  if (record.savedAt !== null) return false
  const database = yield* Database
  const accounts = yield* database.queryRows<
    // Kiln's connection reads timestamps as epoch milliseconds.
    RowDataPacket & { createdAt: number | string; id: string }
  >(
    "recoveryCode.accounts",
    `SELECT id, createdAt FROM ${databaseTable("user")} LIMIT 2`
  )
  const [only] = accounts
  const now = yield* Clock.currentTimeMillis
  return (
    accounts.length === 1 &&
    only?.id === userId &&
    now - Number(only.createdAt) < setupWindowMs
  )
})

const decodeRecord = Schema.decodeUnknownOption(RecoveryRecord)
const decodeRecordJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RecoveryRecord)
)

const loadRecord = Effect.fnUntraced(function* () {
  const database = yield* Database
  const [row] = yield* database.queryRows<
    RowDataPacket & { setting_value: unknown }
  >(
    "recoveryCode.load",
    `SELECT setting_value FROM ${databaseTable("setting")}
      WHERE id = ? AND user_id IS NULL AND setting_key = ?
      LIMIT 1`,
    [recordId, recordKey]
  )
  if (!row) return emptyRecord
  const value = row.setting_value
  return (
    typeof value === "string" ? decodeRecordJson(value) : decodeRecord(value)
  ).pipe(Option.getOrElse(() => emptyRecord))
})

const saveRecord = Effect.fnUntraced(function* (record: RecoveryRecord) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "recoveryCode.save",
    `INSERT INTO ${databaseTable("setting")}
       (id, user_id, setting_key, setting_value, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                             updated_at = VALUES(updated_at)`,
    [recordId, recordKey, JSON.stringify(record), now, now]
  )
})

const platformAdministrator = (user: AuthenticatedUser | null) =>
  signedIn(user).pipe(
    Effect.filterOrFail(
      isPlatformAdmin,
      () => new Error("Only platform administrators can see the recovery code")
    )
  )

/**
 * The Relay that hosts this Kiln, as Kiln's pages pick it, but only among
 * Relays reporting this installation: one hosting another Kiln beside it
 * mustn't hand over that Kiln's code.
 */
async function recoveryHost() {
  const [access, { selectKilnHost }, { kilnInstallationId }] =
    await Promise.all([
      import("@/server/platform-access.server"),
      import("@/lib/kiln-host"),
      import("@/effect/installation"),
    ])
  const installationId = kilnInstallationId()
  const hosts = (await access.kilnPlatformHosts()).filter(
    (host) => host.status?.installationId === installationId
  )
  return {
    access,
    host: selectKilnHost({ hosts, installationId }),
    installationId,
  }
}

async function readRecoveryCode(
  user: AuthenticatedUser
): Promise<RecoveryCodeReveal> {
  const [{ access, host, installationId }, connection] = await Promise.all([
    recoveryHost(),
    import("@/lib/relay-connection"),
  ])
  if (!host?.status?.recovery) {
    throw new Error(
      "No connected Relay has Kiln's recovery code. It's on the Relay that installed Kiln, or one with KILN_PLATFORM_BACKUP_KEY."
    )
  }
  const answer = relayRecoveryCodeSchema.parse(
    await connection.relayRpc(
      await access.platformRelay(host.relayId),
      "relay.platform.recovery.read",
      {},
      15_000,
      user.id
    )
  )
  if (answer.installationId !== installationId) {
    throw new Error("That Relay's recovery code is for another Kiln")
  }
  return answer
}

type RevealInput = {
  readonly headers: Headers
  readonly twoFactorCode: string | null
}

const reveal = operation<RevealInput>()({
  name: "recoveryCode.reveal",
  doing: "Showing Kiln's recovery code",
  authorize: ({ user }) => platformAdministrator(user),
  locks: () => [exclusive(recoveryCodeKey)],
  // The code is checked here, once, rather than in `authorize`, which runs
  // again after a wait and would use up a backup code twice.
  run: ({ context: user, input }) =>
    Effect.gen(function* () {
      if (!(yield* showsWithoutCode(yield* loadRecord(), user.id))) {
        yield* requireTwoFactorCodeEffect(
          user,
          input.twoFactorCode,
          input.headers
        )
      }
      return yield* promiseEffect(() => readRecoveryCode(user))
    }),
  // Records who asked and whether it went through, wrong codes included;
  // never what was shown.
  audit: () => ({ id: "recovery-code", kind: "platform" }),
})

/** Kiln's recovery code, for a platform administrator to save. */
export async function revealRecoveryCode(
  twoFactorCode: string | null,
  headers: Headers
): Promise<RecoveryCodeReveal> {
  return runOperationPromise(
    reveal,
    { headers, twoFactorCode },
    { user: await requireEligibleResourceUser() }
  )
}

const acknowledge = operation<void>()({
  name: "recoveryCode.acknowledge",
  doing: "Saving Kiln's recovery code",
  authorize: ({ user }) => platformAdministrator(user),
  locks: () => [exclusive(recoveryCodeKey)],
  run: ({ context: user }) =>
    Effect.gen(function* () {
      yield* saveRecord({
        savedAt: yield* Clock.currentTimeMillis,
        savedBy: user.id,
      })
    }),
  audit: () => ({ id: "recovery-code", kind: "platform" }),
})

/** Records that a platform administrator saved the recovery code. */
export async function acknowledgeRecoveryCode(): Promise<void> {
  return runOperationPromise(acknowledge, undefined, {
    user: await requireEligibleResourceUser(),
  })
}

/**
 * Whether the recovery code was saved, and by whom, and whether a backup
 * it restores is kept away from this machine. Until it's saved, it also asks
 * the Relay hosting Kiln whether it holds one.
 */
export async function recoveryCodeStatus(): Promise<RecoveryCodeStatus> {
  const user = await requireEligibleResourceUser()
  if (!isPlatformAdmin(user)) {
    throw new Error("Only platform administrators can see the recovery code")
  }
  const record = await runAppEffect("recoveryCode.status", loadRecord())
  const [savedBy, available, recoverableBackup, withoutCode] =
    await Promise.all([
      record.savedBy ? userName(record.savedBy) : null,
      record.savedAt === null
        ? recoverPromise(
            async () => (await recoveryHost()).host?.status?.recovery ?? "none",
            () => "none" as const
          )
        : null,
      runAppEffect("recoveryCode.recoverableBackup", newestRecoverableBackup()),
      runAppEffect("recoveryCode.setup", showsWithoutCode(record, user.id)),
    ])
  return {
    available,
    needsTwoFactor: !withoutCode,
    recoverableBackup,
    saved: record.savedAt === null ? null : { at: record.savedAt, by: savedBy },
    twoFactorEnabled: user.twoFactorEnabled && !user.isDevelopmentBypass,
  }
}

/**
 * The newest platform backup the code alone restores Kiln from (format 2)
 * that has a copy on a backup destination, rather than only on this
 * machine's disk.
 */
const newestRecoverableBackup = Effect.fnUntraced(function* () {
  const database = yield* Database
  const [row] = yield* database.queryRows<
    // Kiln's connection reads timestamps as epoch milliseconds.
    RowDataPacket & { completedAt: number | string | null }
  >(
    "recoveryCode.recoverableBackup",
    `SELECT backup.completed_at AS completedAt
       FROM ${databaseTable("backup")} backup
      WHERE backup.target_kind = 'platform'
        AND backup.status = 'available'
        AND backup.recoverable = 1
        AND EXISTS (
          SELECT 1 FROM ${databaseTable("backup_artifact")} artifact
           WHERE artifact.backup_id = backup.id
             AND artifact.status = 'available'
             AND artifact.storage_id IS NOT NULL
        )
      ORDER BY backup.completed_at DESC
      LIMIT 1`
  )
  return row?.completedAt == null ? null : { at: Number(row.completedAt) }
})

function userName(id: string): Promise<string | null> {
  return runAppEffect(
    "recoveryCode.savedBy",
    Effect.gen(function* () {
      const database = yield* Database
      const [row] = yield* database.queryRows<
        RowDataPacket & { email: string; name: string | null }
      >(
        "recoveryCode.savedBy",
        `SELECT name, email FROM ${databaseTable("user")} WHERE id = ? LIMIT 1`,
        [id]
      )
      return row ? row.name || row.email : null
    })
  )
}
