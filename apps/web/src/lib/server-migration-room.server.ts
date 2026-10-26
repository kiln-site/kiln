import {
  DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
  RelayTransferSpaceSchema,
  relayControlDeadlineMs,
  relayDiskAllocationAvailableBytes,
  relaySnapshotSchema,
  relayTransferSpaceV1Feature,
  type RelayInstance,
  type RelaySnapshot,
} from "@workspace/contracts"
import { Schema } from "effect"

import { resolveBackupStorageSelection } from "@/lib/backup-storage-selection.server"
import { relayConnectionFeatures, relayRpc } from "@/lib/relay-connection"
import type { PersistedRelay } from "@/lib/relay-registry"
import { relayAllocations } from "@/lib/resource-limits.server"
import {
  migrationRoomProblems,
  type MigrationRelayRoom,
  type MigrationRoomProblem,
  type MigrationSourceRoom,
} from "@/lib/server-migration-room"
import type { ServerMigrationOptions } from "@/lib/server-migration-input"

/**
 * What a Relay can give a copy now and, asked about a root, how much that
 * root holds. A Relay too old to say how much room it has for transfers is
 * taken to keep everything on the disk its snapshot reports.
 */
export async function loadRelayRoom(
  relay: PersistedRelay,
  input: { readonly rootId?: string; readonly subject?: string } = {}
): Promise<{
  readonly room: MigrationRelayRoom
  readonly rootBytes: number | null
  readonly snapshot: RelaySnapshot
}> {
  const snapshot = relaySnapshotSchema.parse(
    await relayRpc(relay, "relay.snapshot", {}, 15_000, input.subject)
  )
  const [allocations, space] = await Promise.all([
    relayAllocations(relay, snapshot),
    relayConnectionFeatures(relay.id).has(relayTransferSpaceV1Feature)
      ? relayRpc(
          relay,
          "transfer.space",
          input.rootId ? { rootId: input.rootId } : {},
          relayControlDeadlineMs("transfer.space"),
          input.subject
        ).then((value) =>
          Schema.decodeUnknownSync(RelayTransferSpaceSchema)(value)
        )
      : null,
  ])
  const allocated = (key: "diskBytes" | "memoryBytes") =>
    allocations.reduce((total, item) => total + (item.limits[key] ?? 0), 0)
  const { node } = snapshot
  const nodeFreeBytes = Math.max(
    node.storage.totalBytes - node.storage.usedBytes,
    0
  )
  return {
    room: {
      assignableDiskBytes: relayDiskAllocationAvailableBytes(
        node.storage.totalBytes,
        allocated("diskBytes")
      ),
      assignableMemoryBytes: Math.max(
        node.memory.totalBytes - allocated("memoryBytes"),
        0
      ),
      cores: node.cpu.cores,
      name: relay.name,
      relayId: relay.id,
      rootsFreeBytes: space?.rootsFreeBytes ?? nodeFreeBytes,
      sharedFilesystem: space?.sharedFilesystem ?? true,
      transferFreeBytes: space?.transferFreeBytes ?? nodeFreeBytes,
    },
    rootBytes: space?.rootBytes ?? null,
    snapshot,
  }
}

/**
 * The server's limits as its copy takes them, and its folder's size:
 * measured, else a running server's live figure, else its disk limit.
 */
export function migrationSourceRoom(
  instance: RelayInstance,
  rootBytes: number | null
): MigrationSourceRoom {
  const limits = {
    ...instance.limits,
    diskBytes: instance.limits.diskBytes ?? DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
  }
  if (rootBytes !== null) {
    return { limits, usedBytes: rootBytes, usedFrom: "measured" }
  }
  const live = instance.resources?.storage.usedBytes
  if (live !== null && live !== undefined) {
    return { limits, usedBytes: live, usedFrom: "running" }
  }
  return { limits, usedBytes: limits.diskBytes, usedFrom: "limit" }
}

/** Whether the server's backups go to its own Relay by default. */
export async function defaultBackupIsLocal(
  relayId: string,
  instanceId: string
): Promise<boolean> {
  const [storageId] = await resolveBackupStorageSelection({
    relayId,
    targetId: instanceId,
    targetKind: "instance",
  })
  return storageId === null
}

/**
 * What would keep a copy from fitting, as Relays report it now. With
 * `limits`, the copy's limits are checked too, as before it's created.
 */
export async function checkMigrationRoom(input: {
  readonly backup: ServerMigrationOptions["backup"]
  readonly destination: PersistedRelay
  readonly instanceId: string
  readonly limits: boolean
  readonly source: PersistedRelay
  readonly subject?: string
}): Promise<Array<MigrationRoomProblem>> {
  const same = input.source.id === input.destination.id
  const [source, destination, backupLocal] = await Promise.all([
    loadRelayRoom(input.source, {
      rootId: input.instanceId,
      subject: input.subject,
    }),
    same ? null : loadRelayRoom(input.destination, { subject: input.subject }),
    input.backup === null
      ? false
      : input.backup.storageId === undefined
        ? defaultBackupIsLocal(input.source.id, input.instanceId)
        : input.backup.storageId === null,
  ])
  const instance = source.snapshot.instances.find(
    (item) => item.id === input.instanceId
  )
  if (!instance) throw new Error("Server not found on this Relay")
  return migrationRoomProblems({
    destination: (destination ?? source).room,
    limits: input.limits,
    localBackups: backupLocal ? 1 : 0,
    server: migrationSourceRoom(instance, source.rootBytes),
    source: source.room,
  })
}
