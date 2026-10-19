import { describe, expect, it } from "vite-plus/test"

import {
  backupObjectKey,
  deleteS3PrefixObjectPages,
  failIfS3DeleteObjectsErrored,
  isPublicS3Address,
  isSafeResticObjectPrefix,
  normalizeObjectPrefix,
  normalizeS3Endpoint,
  resticPrefixSegment,
  resticRepositoryObjectPrefix,
} from "./client"

describe("S3 backup storage", () => {
  it("normalizes origins and safe object prefixes", () => {
    expect(normalizeS3Endpoint(" https://s3.example.com/ ")).toBe(
      "https://s3.example.com"
    )
    expect(normalizeObjectPrefix(" /team//production/ ")).toBe(
      "team/production"
    )
    expect(() => normalizeS3Endpoint("http://s3.example.com")).toThrow()
    expect(() => normalizeS3Endpoint("https://s3.example.com/path")).toThrow()
    expect(() => normalizeObjectPrefix("team/../other")).toThrow()
    expect(() => normalizeObjectPrefix("team/foo bar")).toThrow()
    expect(() => normalizeObjectPrefix("é")).toThrow()
    expect(() => normalizeObjectPrefix("a".repeat(513))).toThrow()
  })

  it("bounds generated keys even when target names require heavy escaping", () => {
    const key = backupObjectKey({
      artifactKind: "archive",
      backupId: "00000000-0000-4000-8000-000000000001",
      installationId: "kiln-production",
      objectPrefix: "p".repeat(512),
      relayId: "r".repeat(43),
      targetId: "é".repeat(120),
      targetKind: "instance",
    })
    expect(Buffer.byteLength(key)).toBeLessThanOrEqual(1_024)
    expect(key).toContain("/sha256-")
  })

  it("encodes generated key segments without changing the operator prefix", () => {
    expect(
      backupObjectKey({
        artifactKind: "archive",
        backupId: "00000000-0000-4000-8000-000000000001",
        installationId: "kiln.dev",
        objectPrefix: "team/backups",
        relayId: "relay/id",
        targetId: "server ../ one",
        targetKind: "instance",
      })
    ).toBe(
      "team/backups/kiln/kiln.dev/relay%2Fid/instance/server%20..%2F%20one/00000000-0000-4000-8000-000000000001/backup-00000000.zip"
    )
    expect(
      backupObjectKey({
        artifactKind: "database_dump",
        backupId: "abcdef01-0000-4000-8000-000000000001",
        installationId: "kiln.dev",
        objectPrefix: "team/backups",
        relayId: "relay-id",
        targetId: "database-1",
        targetKind: "database",
      })
    ).toMatch(/\/backup-abcdef01\.dmp\.gz$/u)
    expect(
      backupObjectKey({
        artifactKind: "platform_bundle",
        backupId: "abcdef01-0000-4000-8000-000000000001",
        installationId: "kiln.dev",
        objectPrefix: "team/backups",
        relayId: "relay-id",
        targetId: "platform",
        targetKind: "platform",
      })
    ).toMatch(/\/backup-abcdef01\.kiln$/u)
  })

  it("rejects private, local, reserved, and invalid addresses", () => {
    expect(isPublicS3Address("8.8.8.8")).toBe(true)
    expect(isPublicS3Address("2606:4700:4700::1111")).toBe(true)
    expect(isPublicS3Address("127.0.0.1")).toBe(false)
    expect(isPublicS3Address("10.0.0.1")).toBe(false)
    expect(isPublicS3Address("169.254.169.254")).toBe(false)
    expect(isPublicS3Address("::ffff:127.0.0.1")).toBe(false)
    expect(isPublicS3Address("::ffff:7f00:1")).toBe(false)
    expect(isPublicS3Address("64:ff9b::7f00:1")).toBe(false)
    expect(isPublicS3Address("not-an-address")).toBe(false)
  })
})

describe("restic S3 prefixes", () => {
  it("keeps safe segments and hashes unsafe ones", () => {
    expect(isSafeResticObjectPrefix("team/production")).toBe(true)
    expect(isSafeResticObjectPrefix("team/foo bar")).toBe(false)
    expect(isSafeResticObjectPrefix("team/./other")).toBe(false)
    expect(isSafeResticObjectPrefix("team/../other")).toBe(false)
    expect(resticPrefixSegment("relay-one")).toBe("relay-one")
    expect(resticPrefixSegment(".")).toMatch(/^sha256-[a-f0-9]{64}$/u)
    expect(resticPrefixSegment("..")).toMatch(/^sha256-[a-f0-9]{64}$/u)
    expect(resticPrefixSegment("sha256-already")).toMatch(
      /^sha256-[a-f0-9]{64}$/u
    )
    expect(resticPrefixSegment("relay/id")).toMatch(/^sha256-[a-f0-9]{64}$/u)
    expect(
      resticRepositoryObjectPrefix({
        installationId: "kiln.dev",
        objectPrefix: "team",
        relayId: "relay-one",
        repositoryId: "repo-one",
        targetId: "instance-one",
      })
    ).toBe("team/kiln/kiln.dev/relay-one/restic/instance/instance-one/repo-one")
  })

  it("pages through prefix deletes", async () => {
    const listed: Array<string | undefined> = []
    const deleted: Array<ReadonlyArray<string>> = []
    let scans = 0
    await deleteS3PrefixObjectPages(
      async (token) => {
        listed.push(token)
        if (!token) {
          scans += 1
          if (scans > 1) return { keys: [] }
          return { keys: ["a", "b"], nextToken: "page-2" }
        }
        return { keys: ["c"] }
      },
      async (keys) => {
        deleted.push(keys)
      }
    )
    expect(listed).toEqual([undefined, "page-2", undefined])
    expect(deleted).toEqual([["a", "b"], ["c"]])
  })

  it("re-scans a prefix when objects appear after the final page", async () => {
    const deleted: Array<ReadonlyArray<string>> = []
    let scans = 0
    await deleteS3PrefixObjectPages(
      async () => {
        scans += 1
        if (scans === 1) return { keys: ["first"] }
        if (scans === 2) return { keys: ["late"] }
        return { keys: [] }
      },
      async (keys) => {
        deleted.push(keys)
      }
    )
    expect(deleted).toEqual([["first"], ["late"]])
  })

  it("fails prefix purge when S3 reports per-key delete errors", () => {
    expect(() =>
      failIfS3DeleteObjectsErrored({
        Errors: [
          { Code: "AccessDenied", Key: "pack/a", Message: "Access Denied" },
        ],
      })
    ).toThrow()
    expect(() =>
      failIfS3DeleteObjectsErrored({
        Errors: [
          { Code: "InternalError", Key: "a" },
          { Code: "InternalError", Key: "b" },
        ],
      })
    ).toThrow()
    expect(() => failIfS3DeleteObjectsErrored({ Errors: [] })).not.toThrow()
    expect(() => failIfS3DeleteObjectsErrored({})).not.toThrow()
    expect(() => failIfS3DeleteObjectsErrored({ Errors: [{}] })).toThrow()
  })
})
