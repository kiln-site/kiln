import { S3Client } from "@aws-sdk/client-s3"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import {
  backupObjectKey,
  isPublicS3Address,
  isSafeResticObjectPrefix,
  listS3RepositoryFolder,
  resticPrefixSegment,
  resticRepositoryObjectPrefix,
  signS3BackupAccess,
  signS3RepositoryAccess,
} from "./client"

const credential = {
  accessKeyId: "AKIAEXAMPLE",
  allowPrivateNetwork: true,
  bucket: "kiln-backups",
  endpoint: "https://s3.example.com",
  forcePathStyle: false,
  objectPrefix: "team",
  region: "us-east-1",
  secretAccessKey: "s3-secret",
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("S3 backup storage", () => {
  it("keeps an App's volume's ID one key segment, so it can't nest under another target", () => {
    const appId = "a".repeat(12)
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

describe("signed S3 uploads", () => {
  // The URL is signed before there is an archive. A checksum signed into it
  // would be of an empty body, and buckets that check it refuse the upload.
  it("carry no checksum of a body Hearth never saw", async () => {
    const upload = await Effect.runPromise(
      signS3BackupAccess(credential, "team/backup.zip", "upload")
    )
    const signed = [...new URL(upload.url).searchParams.keys()]
    expect(signed).toContain("X-Amz-Signature")
    expect(signed.filter((name) => /checksum/iu.test(name))).toEqual([])
  })
})

describe("a restic repository in a bucket", () => {
  // The Relay's bridge sends restic's body with a length and nothing else.
  // A header or checksum signed into the request would have to match one
  // the bridge never sends.
  it("signs a file's upload on its address alone", async () => {
    const upload = await Effect.runPromise(
      signS3RepositoryAccess(credential, "team/repo/data/ab/abcd", "PUT")
    )
    const signed = new URL(upload.url).searchParams
    expect(signed.get("X-Amz-SignedHeaders")).toBe("host")
    expect(
      [...signed.keys()].filter((name) => /checksum/iu.test(name))
    ).toEqual([])
    expect(upload.headers).toEqual({})
  })

  // Hearth reads a folder's listing itself, so what it asks the bucket for
  // is all that keeps a Relay to its own repository's files.
  it("lists one folder of one repository, naming only restic's files", async () => {
    const file = "ab".repeat(32)
    const asked: Array<unknown> = []
    vi.spyOn(S3Client.prototype, "send").mockImplementation((async (command: {
      input: unknown
    }) => {
      asked.push(command.input)
      return {
        Contents: [
          { Key: `team/repo/data/ab/${file}`, Size: 12 },
          { Key: "team/repo/data/ab/notes.txt", Size: 3 },
          { Key: "team/repo/data/", Size: 0 },
        ],
        IsTruncated: true,
        NextContinuationToken: "next-page",
      }
    }) as never)

    const page = await Effect.runPromise(
      listS3RepositoryFolder(credential, "team/repo", "data", "this-page")
    )

    expect(asked).toEqual([
      {
        Bucket: "kiln-backups",
        ContinuationToken: "this-page",
        MaxKeys: 1000,
        Prefix: "team/repo/data/",
      },
    ])
    expect(page).toEqual({
      files: [{ name: file, size: 12 }],
      next: "next-page",
      status: "listed",
    })
  })
})
