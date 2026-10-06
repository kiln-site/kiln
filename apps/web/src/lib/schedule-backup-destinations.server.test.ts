import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import {
  scheduleBackupActionSchema,
  scheduleTargetKey,
  type ScheduleTarget,
} from "@workspace/contracts"

import type { AccessGrant } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { requireScheduleBackupDestinations } from "@/lib/schedule-backup-destinations.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows } from "@/test/seed"

const user = {
  id: "user",
  role: "user",
  email: "user@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  isDevelopmentBypass: false,
  name: "User",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser
const storageId = "a01d9771-607d-4c22-b492-fb49c36a8a32"
const target: ScheduleTarget = {
  id: "server-a",
  relayId: "relay-a",
  kind: "instance",
  name: "Server A",
}
const otherTarget: ScheduleTarget = {
  id: "database-b",
  relayId: "relay-b",
  kind: "database",
  name: "Database B",
}
const action = scheduleBackupActionSchema.parse({
  id: storageId,
  type: "backup",
  destination: { kind: "storage", storageId },
})
function grant(
  target: ScheduleTarget,
  permissions: NonNullable<AccessGrant["permissions"]>
): AccessGrant {
  return {
    id: target.id,
    relayId: target.relayId,
    resourceId: target.id,
    resourceType: target.kind,
    permissions,
  }
}
const input = {
  actions: [action],
  targets: [target],
  grants: [grant(target, ["backup.create"])],
  user,
}

const seedStorage = (ownerUserId: string | null) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* insertRows("backup_storage", {
      id: storageId,
      owner_user_id: ownerUserId,
      name: "storage",
      endpoint: "https://s3.example.test",
      region: "us-east-1",
      bucket: "backups",
      access_key_id_ciphertext: "ciphertext",
      secret_access_key_ciphertext: "ciphertext",
      created_at: 0,
      updated_at: 0,
    })
  })

const authorize = (
  overrides: Partial<Parameters<typeof requireScheduleBackupDestinations>[0]>
) =>
  Effect.tryPromise(() =>
    requireScheduleBackupDestinations({ ...input, ...overrides })
  )

const failure = (effect: ReturnType<typeof authorize>) =>
  Effect.map(Effect.flip(effect), (error) => String(error.cause))

// "Personal storage requires backup.download" itself is covered by
// backup-storage-selection.server.test.ts.
describeMysql("scheduled backup export authorization", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "allows export permission on the target and platform admins",
      () =>
        Effect.gen(function* () {
          yield* seedStorage(user.id)
          yield* authorize({ grants: [grant(target, ["backup.download"])] })
          yield* authorize({ user: { ...user, role: "admin" } })
        })
    )

    it.effect(
      "requires export permission independently on every applicable target",
      () =>
        Effect.gen(function* () {
          yield* seedStorage(user.id)
          expect(
            yield* failure(
              authorize({
                targets: [target, otherTarget],
                grants: [grant(target, ["backup.download"])],
              })
            )
          ).toContain("Database B")
        })
    )

    it.effect(
      "honors action target selection and does not require export on unrelated targets",
      () =>
        Effect.gen(function* () {
          yield* seedStorage(user.id)
          yield* authorize({
            actions: [{ ...action, targetKeys: [scheduleTargetKey(target)] }],
            targets: [target, otherTarget],
            grants: [grant(target, ["backup.download"])],
          })
        })
    )

    it.effect(
      "does not use backup policy defaults for omitted destinations",
      () =>
        Effect.gen(function* () {
          yield* seedStorage("other-user")
          yield* insertRows("backup_policy", {
            relay_id: target.relayId,
            target_kind: "instance",
            target_id: target.id,
            storage_id: storageId,
            exclude_patterns: "[]",
            created_at: 0,
            updated_at: 0,
          })
          const local = scheduleBackupActionSchema.parse({
            id: storageId,
            type: "backup",
          })
          yield* authorize({ actions: [local] })
        })
    )

    it.effect("permits shared platform storage without export permission", () =>
      Effect.gen(function* () {
        yield* seedStorage(null)
        yield* authorize({})
      })
    )

    it.effect(
      "prevents assigning another user's or a missing storage during creation or editing",
      () =>
        Effect.gen(function* () {
          yield* seedStorage("other-user")
          expect(
            yield* failure(
              authorize({ grants: [grant(target, ["backup.download"])] })
            )
          ).toContain("unavailable")

          yield* resetDatabase
          expect(
            yield* failure(
              authorize({ grants: [grant(target, ["backup.download"])] })
            )
          ).toContain("unavailable")
        })
    )

    it.effect(
      "requires export for manual execution while retaining the approved destination's owner",
      () =>
        Effect.gen(function* () {
          yield* seedStorage("other-user")
          expect(
            yield* failure(authorize({ checkStorageOwnership: false }))
          ).toContain("backup.download")
          yield* authorize({
            checkStorageOwnership: false,
            grants: [grant(target, ["backup.download"])],
          })
        })
    )
  })
})
