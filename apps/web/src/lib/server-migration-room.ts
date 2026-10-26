import {
  CPU_LIMIT_MILLIS_PER_CORE,
  type ResourceLimits,
} from "@workspace/contracts"

import { formatBytes } from "@/lib/format-bytes"

// Whether a game server's copy fits where it's going, asked before anything
// changes: the copy's limits must fit what the Relay can still assign, and
// each Relay needs free disk for its part of the move. The old server packs
// its files into an archive, beside any backup kept on that Relay; the new
// one fetches the archive and unpacks it, so it holds both until the files
// are in. The archive is counted at the folder's full size, since a world
// barely compresses.

/** What one Relay can give a copy, for those who may create servers there. */
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

/** The server being copied: its folder's size and its limits. */
export interface MigrationSourceRoom {
  readonly limits: ResourceLimits
  readonly usedBytes: number
  /**
   * Where `usedBytes` came from: measured, the live figure of a running
   * server, or its disk limit, when its Relay can't measure a stopped one.
   */
  readonly usedFrom: "measured" | "running" | "limit"
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
  /** Backups the move keeps on the old server's Relay while it runs. */
  readonly localBackups: number
  readonly source: MigrationRelayRoom
  readonly server: MigrationSourceRoom
}): Array<MigrationRoomProblem> {
  const { destination, server, source } = input
  const problems: Array<MigrationRoomProblem> = []
  if (input.limits) {
    const { cpuMillis, diskBytes, memoryBytes } = server.limits
    if (
      cpuMillis !== null &&
      cpuMillis > destination.cores * CPU_LIMIT_MILLIS_PER_CORE
    ) {
      problems.push({
        code: "cpu",
        message: `${destination.name} has ${destination.cores} ${destination.cores === 1 ? "core" : "cores"}, fewer than this server's CPU limit`,
        relayId: destination.relayId,
      })
    }
    if (
      memoryBytes !== null &&
      memoryBytes > destination.assignableMemoryBytes
    ) {
      problems.push({
        code: "memory",
        message: `${destination.name} can assign ${formatBytes(destination.assignableMemoryBytes)} more memory, and this server's limit is ${formatBytes(memoryBytes)}`,
        relayId: destination.relayId,
      })
    }
    if (diskBytes !== null && diskBytes > destination.assignableDiskBytes) {
      problems.push({
        code: "disk_limit",
        message: `${destination.name} can assign ${formatBytes(destination.assignableDiskBytes)} more disk, and this server's limit is ${formatBytes(diskBytes)}`,
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
        message: `This server's files take ${formatBytes(server.usedBytes)}, more than a ${formatBytes(diskBytes)} disk limit`,
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
          ? relay.relayId === source.relayId
            ? "the archive and the copy's files"
            : "the archive and the new server's files"
          : input.localBackups > 0
            ? "the archive and the backup kept on it"
            : "the archive of this server's files"
      }, and has ${formatBytes(short.free)}${
        server.usedFrom === "limit"
          ? " (sized by this server's disk limit; update the Relay to measure it)"
          : ""
      }`,
      relayId: relay.relayId,
    })
  }
  return problems
}
