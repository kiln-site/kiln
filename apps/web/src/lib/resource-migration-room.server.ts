import {
  RelayTransferSpaceSchema,
  relayControlDeadlineMs,
  relayDiskAllocationAvailableBytes,
  relaySnapshotSchema,
  type RelaySnapshot,
  type ResourceLimits,
} from "@workspace/contracts"
import { Schema } from "effect"

import { runAppEffect } from "@/effect/runtime"
import { relayRpc } from "@/lib/relay-connection"
import type { PersistedRelay } from "@/lib/relay-registry"
import { relayAllocations } from "@/lib/resource-limits.server"
import type {
  MigratedKindName,
  ResourceMigrationOptions,
} from "@/lib/resource-migration-input"
import { type MigratedDescription } from "@/lib/resource-migration-kinds/kind.server"
import { migratedKind } from "@/lib/resource-migration-kinds/registry.server"
import {
  migrationRoomProblems,
  type MigrationRelayRoom,
  type MigrationRoomProblem,
  type MigrationSourceRoom,
} from "@/lib/resource-migration-room"

const noLimits: ResourceLimits = {
  cpuMillis: null,
  diskBytes: null,
  memoryBytes: null,
}

/** What a Relay can give a copy now. */
export async function loadRelayRoom(
  relay: PersistedRelay,
  input: { readonly subject?: string } = {}
): Promise<{
  readonly room: MigrationRelayRoom
  readonly snapshot: RelaySnapshot
}> {
  const snapshot = relaySnapshotSchema.parse(
    await relayRpc(relay, "relay.snapshot", {}, 15_000, input.subject)
  )
  const [allocations, space] = await Promise.all([
    relayAllocations(relay, snapshot),
    transferSpace(relay, undefined, input.subject),
  ])
  const allocated = (key: "diskBytes" | "memoryBytes") =>
    allocations.reduce((total, item) => total + (item.limits[key] ?? 0), 0)
  const { node } = snapshot
  const assignableDiskBytes = relayDiskAllocationAvailableBytes(
    node.storage.totalBytes,
    allocated("diskBytes")
  )
  const assignableMemoryBytes = Math.max(
    node.memory.totalBytes - allocated("memoryBytes"),
    0
  )
  return {
    room: {
      assignableDiskBytes,
      assignableMemoryBytes,
      cores: node.cpu.cores,
      name: relay.name,
      relayId: relay.id,
      rootsFreeBytes: space.rootsFreeBytes,
      sharedFilesystem: space.sharedFilesystem,
      transferFreeBytes: space.transferFreeBytes,
    },
    snapshot,
  }
}

/**
 * How much the roots a copy is filled from hold together, as their Relay
 * measures them: null when it can't measure one of them.
 */
export async function measureRoots(
  relay: PersistedRelay,
  rootIds: ReadonlyArray<string>,
  subject?: string
): Promise<number | null> {
  const measured = await Promise.all(
    rootIds.map((rootId) =>
      transferSpace(relay, rootId, subject).then((space) => space.rootBytes)
    )
  )
  return measured.reduce<number | null>(
    (total, bytes) => (total === null || bytes === null ? null : total + bytes),
    0
  )
}

/**
 * The limits a resource's copy takes, its own or those it's given, and how
 * much it holds: measured, else a running one's live figure, else its disk
 * limit.
 */
export function migrationSourceRoom(
  description: MigratedDescription,
  measuredBytes: number | null,
  given: ResourceLimits | null = null
): MigrationSourceRoom {
  const limits = given ?? description.limits ?? noLimits
  if (measuredBytes !== null) {
    return { limits, usedBytes: measuredBytes, usedFrom: "measured" }
  }
  return {
    limits,
    usedBytes: description.usedBytes ?? 0,
    usedFrom: description.usedBytes === null ? "unknown" : description.usedFrom,
  }
}

/**
 * What would keep a copy from fitting, as Relays report it now. With
 * `limits`, the copy's limits are checked too, as before it's created.
 */
export async function checkMigrationRoom(input: {
  readonly backup: ResourceMigrationOptions["backup"]
  /** The copy's limits, when it's given its own. */
  readonly copyLimits: ResourceLimits | null
  readonly destination: PersistedRelay
  readonly kind: MigratedKindName
  readonly limits: boolean
  readonly source: PersistedRelay
  readonly sourceId: string
  readonly subject: string
}): Promise<Array<MigrationRoomProblem>> {
  const kind = migratedKind(input.kind)
  const same = input.source.id === input.destination.id
  const [source, destination, description, measured] = await Promise.all([
    loadRelayRoom(input.source, { subject: input.subject }),
    same ? null : loadRelayRoom(input.destination, { subject: input.subject }),
    kind.describe(input.source, input.sourceId, input.subject),
    runAppEffect(
      "resourceMigrations.sourceRoots",
      kind.sourceRoots(input.source.id, input.sourceId)
    ).then((roots) => measureRoots(input.source, roots, input.subject)),
  ])
  if (!description) {
    throw new Error(`This ${kind.noun} is no longer on its Relay`)
  }
  return migrationRoomProblems({
    destination: (destination ?? source).room,
    limits: input.limits,
    localBackups: input.backup?.storageId === null ? 1 : 0,
    noun: kind.noun,
    resource: migrationSourceRoom(description, measured, input.copyLimits),
    source: source.room,
  })
}

async function transferSpace(
  relay: PersistedRelay,
  rootId: string | undefined,
  subject?: string
) {
  return Schema.decodeUnknownSync(RelayTransferSpaceSchema)(
    await relayRpc(
      relay,
      "transfer.space",
      rootId ? { rootId } : {},
      relayControlDeadlineMs("transfer.space"),
      subject
    )
  )
}
