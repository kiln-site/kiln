import { describe, expect, it } from "vite-plus/test"

import {
  backupObjectKey,
  isPublicS3Address,
  isSafeResticObjectPrefix,
  resticPrefixSegment,
  resticRepositoryObjectPrefix,
} from "./client"

describe("S3 backup storage", () => {
  it("keeps an App's volume's ID one key segment, so it can't nest under another target", () => {
    const appId = "a".repeat(40)
    const key = backupObjectKey({
      artifactKind: "tar_archive",
      backupId: "abcdef01-0000-4000-8000-000000000001",
      installationId: "kiln.dev",
      objectPrefix: "team/backups",
      relayId: "relay-id",
      targetId: `${appId}/pgdata`,
      targetKind: "volume",
    })
    expect(key).toBe(
      `team/backups/kiln/kiln.dev/relay-id/volume/${appId}%2Fpgdata/abcdef01-0000-4000-8000-000000000001/backup-abcdef01.tar.gz`
    )
    // A volume named by the App's ID alone has a key of its own beside it.
    expect(
      backupObjectKey({
        artifactKind: "tar_archive",
        backupId: "abcdef01-0000-4000-8000-000000000001",
        installationId: "kiln.dev",
        objectPrefix: "team/backups",
        relayId: "relay-id",
        targetId: appId,
        targetKind: "volume",
      }).startsWith(`team/backups/kiln/kiln.dev/relay-id/volume/${appId}/`)
    ).toBe(true)
    expect(
      key.startsWith(`team/backups/kiln/kiln.dev/relay-id/volume/${appId}/`)
    ).toBe(false)
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
})
