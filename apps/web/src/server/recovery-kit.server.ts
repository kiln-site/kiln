import {
  encodeRecoveryText,
  recoveryDocument,
  relayRecoveryMaterialSchema,
} from "@workspace/contracts"
import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schema } from "effect"

import { Database } from "@/effect/database"
import { promiseEffect, recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { isPlatformAdmin } from "@/lib/access-control"
import { requireTwoFactorCodeEffect } from "@/lib/auth-two-factor"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"
import {
  recoveryKitFile,
  type RecoveryKitReveal,
  type RecoveryKitStatus,
} from "@/lib/recovery-kit"
import { exclusive } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"

// Kiln's recovery kit, which restores it on a new host and reads its
// platform backups: when it was first shown, and who said they saved it.
// The kit itself stays on the Relay hosting Kiln and is read from it each
// time it's shown; Hearth never stores it, and no journal or audit keeps it.
//
// The first reveal ever needs no second factor: nothing has been shown, and
// on a new installation it's the administrator who just made the account.
// Every reveal after asks for a fresh code.

const recordId = "00000000-0000-4000-8000-000000000006"
const recordKey = "recovery-kit"
/** The record's lane: a reveal reads and marks it, one at a time. */
const recoveryKitKey = "recovery-kit"

const RecoveryRecord = Schema.Struct({
  firstRevealedAt: Schema.NullOr(Schema.Number),
  firstRevealedBy: Schema.NullOr(Schema.String),
  savedAt: Schema.NullOr(Schema.Number),
  savedBy: Schema.NullOr(Schema.String),
})
type RecoveryRecord = typeof RecoveryRecord.Type

const emptyRecord: RecoveryRecord = {
  firstRevealedAt: null,
  firstRevealedBy: null,
  savedAt: null,
  savedBy: null,
}

const decodeRecord = Schema.decodeUnknownOption(RecoveryRecord)
const decodeRecordJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RecoveryRecord)
)

const loadRecord = Effect.fnUntraced(function* () {
  const database = yield* Database
  const [row] = yield* database.queryRows<
    RowDataPacket & { setting_value: unknown }
  >(
    "recoveryKit.load",
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
    "recoveryKit.save",
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
      () =>
        new Error("Only a platform administrator can see Kiln's recovery kit")
    )
  )

/**
 * The Relay that hosts this Kiln, as Kiln's pages pick it, but only among
 * Relays reporting this installation: one hosting another Kiln beside it
 * mustn't hand over that Kiln's kit.
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

async function readRecoveryMaterial(
  user: AuthenticatedUser
): Promise<RecoveryKitReveal> {
  const [{ access, host, installationId }, connection] = await Promise.all([
    recoveryHost(),
    import("@/lib/relay-connection"),
  ])
  if (!host?.status?.recovery) {
    throw new Error(
      "No connected Relay holds Kiln's recovery kit. The Relay that installed Kiln, or one given KILN_PLATFORM_BACKUP_KEY, has it."
    )
  }
  const material = relayRecoveryMaterialSchema.parse(
    await connection.relayRpc(
      await access.platformRelay(host.relayId),
      "relay.platform.recovery.read",
      {},
      15_000,
      user.id
    )
  )
  const document = recoveryDocument(material)
  const materialInstallation =
    material.kind === "kit"
      ? material.kit.state.installationId
      : material.installationId
  if (materialInstallation !== installationId) {
    throw new Error("That Relay's recovery kit is for another Kiln")
  }
  const text = encodeRecoveryText(document)
  return {
    file: recoveryKitFile(document, text),
    installationId,
    kind: material.kind,
    text,
  }
}

type RevealInput = {
  readonly code: string | null
  readonly headers: Headers
}

const reveal = operation<RevealInput>()({
  name: "recoveryKit.reveal",
  doing: "Showing Kiln's recovery kit",
  authorize: ({ user }) => platformAdministrator(user),
  locks: () => [exclusive(recoveryKitKey)],
  // The code is checked here, once, rather than in `authorize`, which runs
  // again after a wait and would use up a backup code twice.
  run: ({ context: user, input }) =>
    Effect.gen(function* () {
      const record = yield* loadRecord()
      const first = record.firstRevealedAt === null
      if (!first) {
        yield* requireTwoFactorCodeEffect(user, input.code, input.headers)
      }
      const material = yield* promiseEffect(() => readRecoveryMaterial(user))
      if (first) {
        yield* saveRecord({
          ...record,
          firstRevealedAt: yield* Clock.currentTimeMillis,
          firstRevealedBy: user.id,
        })
      }
      return material
    }),
  // Records who asked and whether it went through, wrong codes included;
  // never what was shown.
  audit: () => ({ id: "recovery-kit", kind: "platform" }),
})

/** Kiln's recovery kit or key, for a platform administrator to save. */
export async function revealRecoveryKit(
  code: string | null,
  headers: Headers
): Promise<RecoveryKitReveal> {
  return runOperationPromise(
    reveal,
    { code, headers },
    { user: await requireEligibleResourceUser() }
  )
}

const acknowledge = operation<void>()({
  name: "recoveryKit.acknowledge",
  doing: "Saving Kiln's recovery kit",
  authorize: ({ user }) => platformAdministrator(user),
  locks: () => [exclusive(recoveryKitKey)],
  run: ({ context: user }) =>
    Effect.gen(function* () {
      const record = yield* loadRecord()
      yield* saveRecord({
        ...record,
        savedAt: yield* Clock.currentTimeMillis,
        savedBy: user.id,
      })
    }),
  audit: () => ({ id: "recovery-kit", kind: "platform" }),
})

/** Records that a platform administrator saved the recovery kit. */
export async function acknowledgeRecoveryKit(): Promise<void> {
  return runOperationPromise(acknowledge, undefined, {
    user: await requireEligibleResourceUser(),
  })
}

/**
 * Whether the recovery kit was saved, and by whom. Until it is, it also
 * asks the Relay hosting Kiln whether it holds one.
 */
export async function recoveryKitStatus(): Promise<RecoveryKitStatus> {
  const user = await requireEligibleResourceUser()
  if (!isPlatformAdmin(user)) {
    throw new Error("Only a platform administrator can see Kiln's recovery kit")
  }
  const record = await runAppEffect("recoveryKit.status", loadRecord())
  const [savedBy, available] = await Promise.all([
    record.savedBy ? userName(record.savedBy) : null,
    record.savedAt === null
      ? recoverPromise(
          async () => (await recoveryHost()).host?.status?.recovery ?? "none",
          () => "none" as const
        )
      : null,
  ])
  return {
    available,
    firstRevealDone: record.firstRevealedAt !== null,
    saved: record.savedAt === null ? null : { at: record.savedAt, by: savedBy },
    twoFactorEnabled: user.twoFactorEnabled && !user.isDevelopmentBypass,
  }
}

function userName(id: string): Promise<string | null> {
  return runAppEffect(
    "recoveryKit.savedBy",
    Effect.gen(function* () {
      const database = yield* Database
      const [row] = yield* database.queryRows<
        RowDataPacket & { email: string; name: string | null }
      >(
        "recoveryKit.savedBy",
        `SELECT name, email FROM ${databaseTable("user")} WHERE id = ? LIMIT 1`,
        [id]
      )
      return row ? row.name || row.email : null
    })
  )
}
