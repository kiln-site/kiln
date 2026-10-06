import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"

import type { AuthenticatedUser } from "@/lib/auth-session"
import { resolveAuthorizedBackupStorageSelection } from "@/lib/backup-storage-selection.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
} from "@/test/seed"

const user = {
  id: "user-one",
  role: "user",
  email: "user@example.com",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  isDevelopmentBypass: false,
  name: "User",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser

const personal = "11111111-1111-4111-8111-111111111111"
const foreign = "22222222-2222-4222-8222-222222222222"
const platform = "33333333-3333-4333-8333-333333333333"

const storage = (id: string, ownerUserId: string | null) => ({
  id,
  owner_user_id: ownerUserId,
  name: id,
  endpoint: "https://s3.example.test",
  region: "us-east-1",
  bucket: "backups",
  access_key_id_ciphertext: "ciphertext",
  secret_access_key_ciphertext: "ciphertext",
  created_at: 0,
  updated_at: 0,
})

const selection = {
  relayId: "relay-one",
  targetId: "instance-one",
  targetKind: "instance" as const,
  user,
}

const seed = (permission: string | null) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* insertRelay("relay-one")
    yield* insertInstance("relay-one", "instance-one")
    yield* insertRows("backup_storage", [
      storage(personal, user.id),
      storage(foreign, "another-user"),
      storage(platform, null),
    ])
    if (!permission) return
    yield* insertGrant({
      id: "grant",
      userId: user.id,
      relayId: "relay-one",
      resourceType: "instance",
      resourceId: "instance-one",
    })
    yield* insertRows("access_selection", {
      access_id: "grant",
      selection_kind: "permission",
      selection_key: permission,
    })
  })

const resolve = (
  input: Partial<Parameters<typeof resolveAuthorizedBackupStorageSelection>[0]>
) =>
  Effect.tryPromise(() =>
    resolveAuthorizedBackupStorageSelection({ ...selection, ...input })
  )

const failure = (effect: ReturnType<typeof resolve>) =>
  Effect.map(Effect.flip(effect), (error) => String(error.cause))

describeMysql("resolveAuthorizedBackupStorageSelection", () => {
  layer(TestDatabase)((it) => {
    it.effect("requires backup.download for a personal destination", () =>
      Effect.gen(function* () {
        yield* seed("backup.create")
        expect(yield* failure(resolve({ storageId: personal }))).toContain(
          "permission"
        )

        yield* seed("backup.download")
        expect(yield* resolve({ storageId: personal })).toEqual([personal])
      })
    )

    it.effect(
      "rejects another user's destination even with download permission",
      () =>
        Effect.gen(function* () {
          yield* seed("backup.download")
          expect(yield* failure(resolve({ storageId: foreign }))).toContain(
            "Backup destination is unavailable"
          )
        })
    )

    it.effect("rejects a disabled or deleting destination", () =>
      Effect.gen(function* () {
        yield* seed("backup.download")
        const disabled = "44444444-4444-4444-8444-444444444444"
        const deleting = "55555555-5555-4555-8555-555555555555"
        yield* insertRows("backup_storage", [
          { ...storage(disabled, null), enabled: false, deleting: false },
          { ...storage(deleting, null), enabled: true, deleting: true },
        ])
        for (const storageId of [disabled, deleting]) {
          expect(yield* failure(resolve({ storageId }))).toContain(
            "Backup destination is unavailable"
          )
        }
      })
    )

    it.effect("allows platform storage without any grant", () =>
      Effect.gen(function* () {
        yield* seed(null)
        expect(yield* resolve({ storageIds: [null, platform] })).toEqual([
          null,
          platform,
        ])
      })
    )

    it.effect(
      "pins and authorizes the policy default when no destination is selected",
      () =>
        Effect.gen(function* () {
          yield* seed("backup.create")
          yield* insertRows("backup_policy", {
            relay_id: "relay-one",
            target_kind: "instance",
            target_id: "instance-one",
            storage_id: personal,
            exclude_patterns: "[]",
            created_at: 0,
            updated_at: 0,
          })
          expect(yield* failure(resolve({}))).toContain("permission")

          yield* insertRows("access_selection", {
            access_id: "grant",
            selection_kind: "permission",
            selection_key: "backup.download",
          })
          expect(yield* resolve({})).toEqual([personal])
        })
    )
  })
})
