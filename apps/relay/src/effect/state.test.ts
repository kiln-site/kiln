import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { BackupTaskInput } from "@workspace/contracts"

import { makeRelayStateLayer, RelayStateStore } from "./state.js"
import { BROWSER_AUTHORIZATION_FLOOR_RETENTION_MS } from "../browser-security.js"

describe("Relay state", () => {
  stateTest("pairs a client exactly once and persists its grant", () =>
    Effect.gen(function* () {
      const store = yield* RelayStateStore
      const now = Date.UTC(2026, 0, 1)
      yield* store.createInvitation({
        actions: ["*"],
        createdAt: now,
        expiresAt: now + 15 * 60_000,
        id: "invitation-1",
        role: "full_access",
        tokenHash: "hash-1",
      })
      const invitation = yield* store.findActiveInvitation("invitation-1", now)
      assert.isNotNull(invitation)
      if (!invitation) return
      assert.lengthOf(yield* store.listInvitations(now), 1)

      yield* store.pairClient({
        actions: invitation.actions,
        id: "hearth-1",
        invitationId: invitation.id,
        name: "Hearth One",
        origins: ["https://hearth.test"],
        pairedAt: now + 1,
        publicKey: "public-key-1",
        role: invitation.role,
        sourceCidrs: [],
      })
      assert.isNull(yield* store.findActiveInvitation("invitation-1", now + 2))
      const paired = yield* store.findClientByPublicKey("public-key-1")
      assert.deepStrictEqual(paired, {
        actions: ["*"],
        id: "hearth-1",
        invitationId: invitation.id,
        name: "Hearth One",
        origins: ["https://hearth.test"],
        publicKey: "public-key-1",
        role: "full_access",
        sourceCidrs: [],
        createdAt: now + 1,
        lastAddress: null,
        lastSeenAt: now + 1,
      })

      assert.isTrue(
        yield* store.updateClient({
          actions: ["relay.read"],
          clientId: "hearth-1",
          name: "Hearth Renamed",
          role: "read_only",
          sourceCidrs: ["192.0.2.1/32"],
        })
      )
      yield* store.touchClient("hearth-1", now + 2, "192.0.2.1")
      const updated = yield* store.findClientById("hearth-1")
      assert.strictEqual(updated?.name, "Hearth Renamed")
      assert.strictEqual(updated?.lastAddress, "192.0.2.1")
      assert.deepStrictEqual(updated?.sourceCidrs, ["192.0.2.1/32"])

      const duplicate = yield* Effect.result(
        store.pairClient({
          actions: invitation.actions,
          id: "hearth-2",
          invitationId: invitation.id,
          name: "Hearth Two",
          origins: [],
          pairedAt: now + 3,
          publicKey: "public-key-2",
          role: invitation.role,
          sourceCidrs: [],
        })
      )
      assert.strictEqual(duplicate._tag, "Failure")
    })
  )

  stateTest("revokes clients without deleting their durable record", () =>
    Effect.gen(function* () {
      const store = yield* RelayStateStore
      const now = Date.UTC(2026, 0, 1)
      yield* store.createInvitation({
        actions: ["*"],
        createdAt: now,
        expiresAt: now + 15 * 60_000,
        id: "invitation-1",
        role: "full_access",
        tokenHash: "hash-1",
      })
      yield* store.pairClient({
        actions: ["*"],
        id: "hearth-1",
        invitationId: "invitation-1",
        name: "Hearth One",
        origins: ["https://hearth.test"],
        pairedAt: now + 1,
        publicKey: "public-key-1",
        role: "full_access",
        sourceCidrs: [],
      })
      assert.isTrue(yield* store.revokeClient("hearth-1", Date.UTC(2026, 0, 2)))
      assert.isNull(yield* store.findClientById("hearth-1"))
      assert.isNull(yield* store.findClientByPublicKey("public-key-1"))
      assert.isFalse(
        yield* store.revokeClient("hearth-1", Date.UTC(2026, 0, 3))
      )
    })
  )

  stateTest(
    "persists monotonic browser floors and bounded replay entries",
    () =>
      Effect.gen(function* () {
        const store = yield* RelayStateStore
        const now = Date.UTC(2026, 0, 4)
        const first = yield* store.reviseBrowserAuthorization(
          "browser-issuer",
          [
            {
              minimumRevision: 7,
              scope: { instanceId: "instance-a", kind: "instance" },
              subject: "user-a",
            },
            {
              minimumRevision: 9,
              scope: {
                kind: "login_session",
                loginSessionId: "session-a",
              },
              subject: "user-a",
            },
          ],
          3,
          now
        )
        assert.strictEqual(first.issuerGeneration, 3)
        assert.strictEqual(
          (yield* store.browserAuthority({
            instanceId: "instance-a",
            issuer: "browser-issuer",
            loginSessionId: "session-a",
            subject: "user-a",
          })).minimumRevision,
          9
        )
        const stale = yield* store.reviseBrowserAuthorization(
          "browser-issuer",
          [
            {
              minimumRevision: 2,
              scope: { instanceId: "instance-a", kind: "instance" },
              subject: "user-a",
            },
          ],
          1,
          now + 1
        )
        assert.strictEqual(stale.issuerGeneration, 3)
        assert.strictEqual(stale.items[0]?.minimumRevision, 7)

        yield* store.reviseBrowserAuthorization(
          "browser-issuer",
          [
            {
              minimumRevision: 10,
              scope: { kind: "subject_relay" },
              subject: "user-b",
            },
          ],
          undefined,
          now + BROWSER_AUTHORIZATION_FLOOR_RETENTION_MS + 1
        )
        assert.strictEqual(
          (yield* store.browserAuthority({
            instanceId: "instance-a",
            issuer: "browser-issuer",
            loginSessionId: "session-a",
            subject: "user-a",
          })).minimumRevision,
          0
        )

        assert.strictEqual(
          yield* store.reserveBrowserFileReplay({
            capabilityId: "capability-a",
            expiresAt: now + 60_000,
            maxEntries: 1,
            nonce: "nonce-a",
            now,
          }),
          "reserved"
        )
        assert.strictEqual(
          yield* store.reserveBrowserFileReplay({
            capabilityId: "capability-a",
            expiresAt: now + 60_000,
            maxEntries: 1,
            nonce: "nonce-a",
            now,
          }),
          "replayed"
        )
        assert.strictEqual(
          yield* store.reserveBrowserFileReplay({
            capabilityId: "capability-b",
            expiresAt: now + 60_000,
            maxEntries: 1,
            nonce: "nonce-b",
            now,
          }),
          "full"
        )
        assert.strictEqual(
          yield* store.reserveBrowserFileReplay({
            capabilityId: "capability-b",
            expiresAt: now + 120_000,
            maxEntries: 1,
            nonce: "nonce-b",
            now: now + 60_001,
          }),
          "reserved"
        )
      })
  )

  stateTest("scrubs S3 keys from terminal journal rows", () =>
    Effect.gen(function* () {
      const store = yield* RelayStateStore
      const input: BackupTaskInput = {
        artifactKind: "restic_snapshot",
        backupId: "41100000-0000-4000-8000-000000000001",
        destination: {
          kind: "restic",
          repository: {
            accessKeyId: "AKIAEXAMPLE",
            allowPrivateNetwork: true,
            bucket: "kiln-backups",
            endpoint: "https://s3.example.com",
            forcePathStyle: true,
            kind: "s3",
            region: "us-east-1",
            repositoryPrefix: "team/repo",
            secretAccessKey: "s3-secret",
          },
          repositoryPassword: "repo-secret",
        },
        exclude: [],
        kind: "create",
        maxBytes: null,
        mode: "incremental",
        reason: "manual",
        target: { id: "instance-a", kind: "instance" },
        taskId: "41100000-0000-4000-8000-000000000011",
      }
      yield* store.enqueueBackupTask(input, 530)
      yield* store.claimNextBackupTask(540)
      assert.isTrue(
        yield* store.completeBackupTask(
          input.taskId,
          {
            bytes: 12,
            snapshotId: "abcdef12",
            warnings: [],
          },
          550
        )
      )
      const completed = yield* store.getBackupTask(input.taskId)
      const destination =
        completed?.input.kind === "create" &&
        completed.input.destination.kind === "restic"
          ? completed.input.destination
          : null
      assert.isDefined(destination)
      if (!destination) return
      assert.strictEqual(destination.repositoryPassword, undefined)
      assert.strictEqual(
        destination.repository?.kind === "s3"
          ? destination.repository.accessKeyId
          : "present",
        undefined
      )
      assert.strictEqual(
        destination.repository?.kind === "s3"
          ? destination.repository.secretAccessKey
          : "present",
        undefined
      )
    })
  )
})

/** Gives each test its own SQLite file so tests never share rows or run order. */
function stateTest(
  name: string,
  body: (filename: string) => Effect.Effect<unknown, unknown, RelayStateStore>
) {
  it.effect(name, () =>
    withTemporaryDirectory((directory) => {
      const filename = join(directory, "relay.sqlite")
      return body(filename).pipe(Effect.provide(makeRelayStateLayer(filename)))
    })
  )
}

function withTemporaryDirectory<A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "kiln-relay-state-"))),
    use,
    (directory) =>
      Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
  )
}
