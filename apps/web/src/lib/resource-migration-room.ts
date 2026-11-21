import {
  CPU_LIMIT_MILLIS_PER_CORE,
  type ResourceLimits,
} from "@workspace/contracts"

import { formatBytes } from "@/lib/format-bytes"

// Whether a resource's copy fits where it's going, asked before anything
// changes: the copy's limits must fit what the Relay can still assign, and
// each Relay needs free disk for its part of the move. The old one's Relay
// packs its data into an archive, beside any backup kept on that Relay; the
// new one's fetches the archive and unpacks it, so it holds both until the
// data is in. The archive is counted at the data's full size, since a world
// barely compresses.

/** What one Relay can give a copy, for those who may create one there. */
export interface MigrationRelayRoom {
  readonly name: string
  readonly relayId: string
  readonly cores: number
  /** Memory and disk its limits can still take, past every instance's. */
  readonly assignableMemoryBytes: number
  readonly assignableDiskBytes: number
  /** Free disk where it keeps archives and backups. */
  readonly transferFreeBytes: number
  /** Free disk where it keeps game servers' folders. */
  readonly rootsFreeBytes: number
  /** Whether both are one filesystem, sharing their free bytes. */
  readonly sharedFilesystem: boolean
}

/** The resource being copied: how much it holds and its limits. */
export interface MigrationSourceRoom {
  readonly limits: ResourceLimits
  readonly usedBytes: number
  /**
   * Where `usedBytes` came from: measured, the live figure of a running
   * one, or its disk limit, when its Relay can't measure a stopped one.
   * Unknown when nothing says how much it holds, and it's counted as none.
   */
  readonly usedFrom: "measured" | "running" | "limit" | "unknown"
}

export interface MigrationRoomProblem {
  readonly code: "cpu" | "disk_files" | "disk_limit" | "memory" | "space"
  readonly message: string
  readonly relayId: string
}

export function migrationRoomProblems(input: {
  readonly destination: MigrationRelayRoom
  /** Whether to check the copy's limits too, as before it's created. */
  readonly limits: boolean
  /** Backups the move keeps on the old one's Relay while it runs. */
  readonly localBackups: number
  /** What the messages call it: "game server", "database". */
  readonly noun: string
  readonly resource: MigrationSourceRoom
  readonly source: MigrationRelayRoom
}): Array<MigrationRoomProblem> {
  const { destination, noun, source } = input
  const server = input.resource
  const problems: Array<MigrationRoomProblem> = []
  if (input.limits) {
    const { cpuMillis, diskBytes, memoryBytes } = server.limits
    if (
      cpuMillis !== null &&
      cpuMillis > destination.cores * CPU_LIMIT_MILLIS_PER_CORE
    ) {
      problems.push({
        code: "cpu",
        message: `${destination.name} has ${destination.cores} ${destination.cores === 1 ? "core" : "cores"}, fewer than this ${noun}'s CPU limit`,
        relayId: destination.relayId,
      })
    }
    if (
      memoryBytes !== null &&
      memoryBytes > destination.assignableMemoryBytes
    ) {
      problems.push({
        code: "memory",
        message: `${destination.name} can assign ${formatBytes(destination.assignableMemoryBytes)} more memory, and this ${noun}'s limit is ${formatBytes(memoryBytes)}`,
        relayId: destination.relayId,
      })
    }
    if (diskBytes !== null && diskBytes > destination.assignableDiskBytes) {
      problems.push({
        code: "disk_limit",
        message: `${destination.name} can assign ${formatBytes(destination.assignableDiskBytes)} more disk, and this ${noun}'s limit is ${formatBytes(diskBytes)}`,
        relayId: destination.relayId,
      })
    } else if (
      diskBytes !== null &&
      server.usedFrom !== "limit" &&
      diskBytes < server.usedBytes
    ) {
      // A copy whose files already fill its disk couldn't start.
      problems.push({
        code: "disk_files",
        message: `This ${noun}'s data takes ${formatBytes(server.usedBytes)}, more than a ${formatBytes(diskBytes)} disk limit`,
        relayId: destination.relayId,
      })
    }
  }

  // Bytes each Relay must hold at once, where it keeps archives and where
  // it keeps folders.
  const needs = new Map<string, { roots: number; transfer: number }>()
  const need = (relayId: string, transfer: number, roots: number) => {
    const current = needs.get(relayId) ?? { roots: 0, transfer: 0 }
    needs.set(relayId, {
      roots: current.roots + roots,
      transfer: current.transfer + transfer,
    })
  }
  need(source.relayId, server.usedBytes * (1 + input.localBackups), 0)
  need(destination.relayId, server.usedBytes, server.usedBytes)
  for (const relay of source.relayId === destination.relayId
    ? [source]
    : [source, destination]) {
    const needed = needs.get(relay.relayId)
    if (!needed) continue
    // On one filesystem the two share their free bytes.
    const short = (
      relay.sharedFilesystem
        ? [
            {
              free: Math.min(relay.transferFreeBytes, relay.rootsFreeBytes),
              needed: needed.roots + needed.transfer,
            },
          ]
        : [
            { free: relay.transferFreeBytes, needed: needed.transfer },
            { free: relay.rootsFreeBytes, needed: needed.roots },
          ]
    ).find((check) => check.needed > check.free)
    if (!short) continue
    problems.push({
      code: "space",
      message: `${relay.name} needs ${formatBytes(short.needed)} of free disk for ${
        relay.relayId === destination.relayId
          ? "the archive and the copy's data"
          : input.localBackups > 0
            ? "the archive and the backup kept on it"
            : `the archive of this ${noun}'s data`
      }, and has ${formatBytes(short.free)}${
        server.usedFrom === "limit"
          ? ` (sized by this ${noun}'s disk limit; update the Relay to measure it)`
          : ""
      }`,
      relayId: relay.relayId,
    })
  }
  return problems
}
