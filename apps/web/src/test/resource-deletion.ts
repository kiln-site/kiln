import { randomUUID } from "node:crypto"

import { Effect, Schedule } from "effect"

import { Database } from "@/effect/database"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { resetDatabase } from "@/test/database"
import {
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

// What deletion tests share: a fake Relay, and a game server on it that
// its owner may delete; Apps and volumes are added as a test needs them.

export const relayId = "r".repeat(43)
export const serverId = "a".repeat(40)
export const appId = "e".repeat(40)
export const volumeId = "f".repeat(40)
const at = 1_767_225_600_000

const person = (id: string) =>
  ({
    email: `${id}@example.test`,
    emailVerified: true,
    emailVerifiedAt: "2026-01-01T00:00:00.000Z",
    id,
    isDevelopmentBypass: false,
    name: id,
    role: "user",
    twoFactorEnabled: false,
  }) satisfies AuthenticatedUser
export const owner = person("owner")
// Signed in, verified, and without any access to the game server.
export const stranger = person("stranger")

/** The owner's grant on one resource, with just these permissions. */
const allow = (
  resourceType: "instance" | "relay",
  resourceId: string,
  permissions: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertRows("access_grant", {
      created_at: at,
      id,
      relay_id: relayId,
      resource_id: resourceId,
      resource_type: resourceType,
      role: null,
      state: "active",
      updated_at: at,
      user_id: owner.id,
    })
    yield* insertRows(
      "access_selection",
      permissions.map((permission) => ({
        access_id: id,
        selection_key: permission,
        selection_kind: "permission",
      }))
    )
  })

// Waits a while for every operation an earlier test started to end, its
// workflow's last writes included, so emptying the tables doesn't wait on
// them. One a stopped test run left running never ends; it's emptied anyway.
const operationsEnded = selectRows<{ state: string }>("operation").pipe(
  Effect.repeat({
    schedule: Schedule.spaced("100 millis"),
    until: (rows) =>
      rows.every((row) =>
        ["cancelled", "failed", "interrupted", "succeeded"].includes(row.state)
      ),
  }),
  Effect.timeoutOption("15 seconds")
)

/** A fresh database with the owner's game server, on a fresh Relay. */
export const seedDeletion = Effect.gen(function* () {
  yield* operationsEnded
  yield* resetDatabase
  resetDeletionRelay([serverId])
  yield* insertRelay(relayId)
  for (const user of [owner, stranger]) {
    yield* insertUser(user.id, { emailVerifiedAt: new Date(at) })
  }
  yield* allow("instance", serverId, ["instance.delete", "backup.create"])
  yield* insertInstance(relayId, serverId, { display_name: "Survival" })
})

const deletionOf = (resourceId: string) =>
  selectRows<{
    attempt: number
    backup_id: string | null
    error: string | null
    id: string
    relay_deleted_at: number | null
    relay_deleting_at: number | null
    resource_id: string
    status: string
  }>("resource_deletion").pipe(
    Effect.map((rows) => rows.find((row) => row.resource_id === resourceId))
  )

/** Waits, on the live clock, for a deletion to reach one of `statuses`. */
export const deletionUntil = (
  resourceId: string,
  statuses: ReadonlyArray<string>
) =>
  deletionOf(resourceId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("100 millis"),
      until: (row) => row !== undefined && statuses.includes(row.status),
    }),
    Effect.timeout("45 seconds")
  )

/** Waits for a deletion to follow a final backup other than `previous`. */
export const nextBackup = (resourceId: string, previous: string | null) =>
  deletionOf(resourceId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("100 millis"),
      until: (row) => row?.backup_id != null && row.backup_id !== previous,
    }),
    Effect.timeout("30 seconds"),
    Effect.map((row) => row?.backup_id ?? "")
  )

/** The Relay finished a final backup, as reconciling records it. */
export const finishBackup = (backupId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.execute(
      "test.finishBackup",
      `UPDATE kiln_backup SET status = 'available' WHERE id = ?`,
      [backupId]
    )
  })

export const serverRecords = selectRows<{ instance_id: string }>(
  "instance"
).pipe(Effect.map((rows) => rows.map((row) => row.instance_id)))

/**
 * A Relay for deletion tests, faked at `@/lib/relay-connection`: the game
 * servers and Apps it has, which it froze and for which deletion, every
 * change asked of it, and an outcome journal by command ID, as its control
 * socket keeps.
 */
export const deletionRelay = {
  // The volumes each App deletion was allowed to take.
  appDeletes: [] as Array<ReadonlyArray<string> | undefined>,
  apps: new Set<string>(),
  changes: [] as Array<string>,
  frozen: new Map<string, string>(),
  journal: new Map<string, unknown>(),
  servers: new Set<string>(),
  volumes: [] as Array<FakeVolume>,
}

/** A volume as the Relay lists it, with only what deletion reads. */
export interface FakeVolume {
  id: string
  // Another App's, or a container's, of kind and resource.
  mounts?: Array<{ kind: "app" | "other"; resourceId: string | null }>
  owner?: string
  users?: Array<{ appId: string; configured: boolean }>
}

/**
 * An App, and these volumes, on the Relay, which the owner may delete and
 * back up.
 */
export const seedApp = (volumes: ReadonlyArray<FakeVolume> = []) =>
  Effect.gen(function* () {
    deletionRelay.apps.add(appId)
    deletionRelay.volumes.push(...volumes)
    yield* insertRows("app", {
      app_id: appId,
      config_ciphertext: "ciphertext",
      created_at: at,
      created_by: owner.id,
      name: "Website",
      relay_id: relayId,
      updated_at: at,
    })
    // Apps aren't shared one by one: the Relay's grant covers them, and its
    // Kiln volumes.
    yield* allow("relay", relayId, [
      "app.delete",
      "app.files.read",
      "backup.create",
      "relay.configure",
    ])
  })

export const appRecords = selectRows<{ app_id: string }>("app").pipe(
  Effect.map((rows) => rows.map((row) => row.app_id))
)

function resetDeletionRelay(servers: ReadonlyArray<string>): void {
  deletionRelay.appDeletes.length = 0
  deletionRelay.apps.clear()
  deletionRelay.changes.length = 0
  deletionRelay.frozen.clear()
  deletionRelay.journal.clear()
  deletionRelay.servers.clear()
  deletionRelay.volumes.length = 0
  for (const id of servers) deletionRelay.servers.add(id)
}

/** What a test's `vi.mock("@/lib/relay-connection")` replaces. */
export const deletionRelayConnection = {
  relayJournal: async () => ({
    clientId: "hearth-one",
    journalId: "journal-one",
  }),
  relayRpc: async (
    relay: { id: string },
    operation: string,
    payload: Record<string, unknown>,
    _timeout?: number,
    _subject?: string,
    _signal?: AbortSignal,
    frame: { operationId?: string } = {}
  ): Promise<unknown> => {
    const state = deletionRelay
    if (operation === "operation.get") {
      return (
        state.journal.get(String(payload.operationId)) ?? { status: "unknown" }
      )
    }
    if (operation === "relay.snapshot") return snapshot(relay.id)
    if (operation === "database.list" || operation === "app.list") {
      const id = String(
        (payload.requests as Array<{ id: string }>)[0]?.id ?? ""
      )
      return operation === "app.list" && state.apps.has(id) ? [{ id }] : []
    }
    if (operation === "relay.volumes.read") return listedVolumes()
    // Backups are queued and followed by Hearth's own records here.
    if (operation === "backup.task.list") return []
    if (operation === "backup.task.enqueue") {
      throw new Error("The Relay's backup queue is busy")
    }
    state.changes.push(operation)
    const id = String(
      payload.id ?? payload.instanceId ?? payload.databaseId ?? payload.appId
    )
    let result: unknown
    switch (operation) {
      case "resource.freeze":
        state.frozen.set(id, String(payload.deletionId))
        result = { frozen: true }
        break
      case "resource.unfreeze":
        if (state.frozen.get(id) === payload.deletionId) state.frozen.delete(id)
        result = { frozen: state.frozen.has(id) }
        break
      case "app.delete":
      case "relay.volumes.delete":
        if (operation === "app.delete") {
          const allowed = payload.volumeIds as ReadonlyArray<string> | undefined
          state.appDeletes.push(allowed)
          state.apps.delete(id)
          // It takes the volumes only it uses that its deletion names.
          state.volumes = state.volumes.filter(
            (volume) =>
              !(
                volume.owner === id &&
                onlyUsedBy(volume, id) &&
                (allowed ?? [volume.id]).includes(volume.id)
              )
          )
        } else {
          state.volumes = state.volumes.filter((volume) => volume.id !== id)
        }
        state.frozen.delete(id)
        result =
          operation === "app.delete" ? { appId: id, deleted: true } : { id }
        break
      case "instance.delete":
      case "database.delete":
        state.servers.delete(id)
        state.frozen.delete(id)
        result =
          operation === "instance.delete"
            ? { deleted: true, instanceId: id }
            : { databaseId: id, deleted: true }
        break
      default:
        throw new Error(`Unexpected Relay operation ${operation}`)
    }
    if (frame.operationId) {
      state.journal.set(frame.operationId, { result, status: "succeeded" })
    }
    return result
  },
}

function onlyUsedBy(volume: FakeVolume, appId: string): boolean {
  return (
    (volume.users ?? []).every((user) => user.appId === appId) &&
    (volume.mounts ?? []).every(
      (mount) => mount.kind === "app" && mount.resourceId === appId
    )
  )
}

function listedVolumes() {
  return {
    measuring: false,
    protection: { ready: true, reason: null },
    uncovered: [],
    volumes: deletionRelay.volumes.map((volume) => ({
      createdAt: null,
      dockerName: `volume-${volume.id.replace("/", "_")}`,
      id: volume.id,
      kind: volume.owner ? "app" : "kiln",
      mountpoint: null,
      mounts: (volume.mounts ?? []).map((mount) => ({
        container: `${mount.kind}-container`,
        destination: "/data",
        kind: mount.kind,
        readOnly: false,
        resourceId: mount.resourceId,
        running: false,
      })),
      name: volume.id.split("/").at(-1),
      owner: volume.owner
        ? { appId: volume.owner, volume: volume.id.split("/").at(-1) }
        : null,
      sizeBytes: null,
      users: (volume.users ?? []).map((user) => ({
        ...user,
        mounted: !user.configured,
      })),
    })),
  }
}

function snapshot(relayId: string) {
  return {
    instances: [...deletionRelay.servers].map((id) => ({
      connectAddress: "play.example.test:25565",
      containerId: null,
      desiredState: "stopped",
      directory: "/data/survival",
      game: "Minecraft",
      id,
      implementation: "paper",
      javaVersion: "21",
      name: "Survival",
      observedState: "stopped",
      service: "survival",
      shortId: id.slice(0, 8),
      status: "stopped",
      version: "1.21",
    })),
    node: {
      arch: "arm64",
      connectedAt: "2026-01-01T00:00:00.000Z",
      cpu: { cores: 4, loadPercent: 0 },
      docker: { available: true, version: "test" },
      id: relayId,
      memory: { totalBytes: 1, usedBytes: 0 },
      name: "Relay",
      platform: "linux",
      storage: { totalBytes: 1, usedBytes: 0 },
      version: "test",
    },
  }
}
