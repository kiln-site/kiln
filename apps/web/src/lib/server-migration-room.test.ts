import { describe, expect, it } from "vite-plus/test"

import {
  migrationRoomProblems,
  type MigrationRelayRoom,
  type MigrationSourceRoom,
} from "@/lib/server-migration-room"

const GiB = 1024 ** 3

function relay(
  relayId: string,
  room: Partial<MigrationRelayRoom> = {}
): MigrationRelayRoom {
  return {
    assignableDiskBytes: 500 * GiB,
    assignableMemoryBytes: 16 * GiB,
    cores: 8,
    name: relayId.toUpperCase(),
    relayId,
    rootsFreeBytes: 500 * GiB,
    sharedFilesystem: true,
    transferFreeBytes: 500 * GiB,
    ...room,
  }
}

const server: MigrationSourceRoom = {
  limits: { cpuMillis: null, diskBytes: 10 * GiB, memoryBytes: 3 * GiB },
  usedBytes: 2 * GiB,
  usedFrom: "measured",
}

function codes(problems: ReturnType<typeof migrationRoomProblems>) {
  return problems.map((problem) => `${problem.relayId}:${problem.code}`)
}

describe("Room for a game server's copy", () => {
  it("refuses a copy whose memory limit the destination can't assign", () => {
    const problems = migrationRoomProblems({
      destination: relay("s01", { assignableMemoryBytes: 0.2 * GiB }),
      limits: true,
      localBackups: 0,
      server,
      source: relay("q02"),
    })

    expect(codes(problems)).toEqual(["s01:memory"])
  })

  it("refuses a disk limit the server's files wouldn't fit in", () => {
    const check = (diskBytes: number) =>
      codes(
        migrationRoomProblems({
          destination: relay("s01"),
          limits: true,
          localBackups: 0,
          server: { ...server, limits: { ...server.limits, diskBytes } },
          source: relay("q02"),
        })
      )

    expect(check(1 * GiB)).toEqual(["s01:disk_files"])
    expect(check(3 * GiB)).toEqual([])
  })

  it("needs room for both the archive and the unpacked files on the destination", () => {
    const check = (free: number) =>
      codes(
        migrationRoomProblems({
          destination: relay("s01", {
            rootsFreeBytes: free,
            transferFreeBytes: free,
          }),
          limits: true,
          localBackups: 0,
          server,
          source: relay("q02"),
        })
      )

    expect(check(3 * GiB)).toEqual(["s01:space"])
    expect(check(4 * GiB)).toEqual([])
  })

  it("needs room on the old server's Relay for its archive and a backup kept there", () => {
    const check = (localBackups: number) =>
      codes(
        migrationRoomProblems({
          destination: relay("s01"),
          limits: true,
          localBackups,
          server,
          source: relay("q02", {
            rootsFreeBytes: 3 * GiB,
            transferFreeBytes: 3 * GiB,
          }),
        })
      )

    expect(check(0)).toEqual([])
    expect(check(1)).toEqual(["q02:space"])
  })

  it("counts the archive, the fetched copy of it, and the files together on one Relay", () => {
    const check = (free: number) =>
      codes(
        migrationRoomProblems({
          destination: relay("q02", {
            rootsFreeBytes: free,
            transferFreeBytes: free,
          }),
          limits: true,
          localBackups: 0,
          server,
          source: relay("q02", {
            rootsFreeBytes: free,
            transferFreeBytes: free,
          }),
        })
      )

    expect(check(5 * GiB)).toEqual(["q02:space"])
    expect(check(6 * GiB)).toEqual([])
  })

  it("checks archives and folders against their own disks when they're apart", () => {
    const problems = migrationRoomProblems({
      destination: relay("s01", {
        rootsFreeBytes: 1 * GiB,
        sharedFilesystem: false,
        transferFreeBytes: 100 * GiB,
      }),
      limits: false,
      localBackups: 0,
      server,
      source: relay("q02"),
    })

    expect(codes(problems)).toEqual(["s01:space"])
  })
})
