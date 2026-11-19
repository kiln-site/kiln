import { describe, expect, it } from "vite-plus/test"

import {
  backupTaskInputSchema,
  omitBackupSecrets,
  redactBackupTaskInput,
  resticRepositoryLocationSchema,
} from "./backups.js"

const backupId = "11111111-1111-4111-8111-111111111111"
const taskId = "22222222-2222-4222-8222-222222222222"
const target = { id: "instance-one", kind: "instance" as const }

const s3Repository = {
  accessKeyId: "AKIAEXAMPLE",
  allowPrivateNetwork: true,
  bucket: "kiln-backups",
  endpoint: "https://s3.example.com",
  forcePathStyle: true,
  kind: "s3" as const,
  region: "us-east-1",
  repositoryPrefix: "team/kiln/relay/restic/instance/srv/repo",
  secretAccessKey: "s3-secret",
}

describe("Relay backup task inputs", () => {
  // A Relay reads back every backup it made, however long ago.
  it("reads a backup made when it carried the volumes its App used", () => {
    const stored = {
      appCoverage: { appId: "a".repeat(12), volumeIds: ["v".repeat(40)] },
      artifactKind: "tar_archive",
      backupId,
      destination: { kind: "local" },
      exclude: [],
      kind: "create",
      maxBytes: null,
      mode: "full",
      reason: "scheduled",
      target: { id: "c".repeat(40), kind: "volume" },
      taskId,
    }
    const read = backupTaskInputSchema.parse(stored)
    expect(read).toMatchObject({ kind: "create", target: stored.target })
  })

  it("rejects S3 repositories with plaintext endpoints, invalid ports, or escaping prefixes", () => {
    expect(resticRepositoryLocationSchema.safeParse(s3Repository).success).toBe(
      true
    )
    for (const unsafe of [
      { endpoint: "http://minio:9000" },
      { endpoint: "https://minio:0" },
      { repositoryPrefix: "../escape" },
    ]) {
      expect(
        resticRepositoryLocationSchema.safeParse({ ...s3Repository, ...unsafe })
          .success
      ).toBe(false)
    }
  })

  it("strips repository passwords and S3 keys from restic task input", () => {
    const redacted = redactBackupTaskInput({
      artifactKind: "restic_snapshot",
      backupId,
      destination: {
        kind: "restic",
        repository: s3Repository,
        repositoryPassword: "repo-secret",
      },
      exclude: [],
      kind: "create",
      maxBytes: null,
      mode: "incremental",
      reason: "manual",
      target,
      taskId,
    })

    expect(JSON.stringify(redacted)).not.toMatch(
      /repo-secret|AKIAEXAMPLE|s3-secret/u
    )
    expect(
      omitBackupSecrets({
        accessKeyId: "AKIAEXAMPLE",
        nested: { repositoryPassword: "secret", value: 1 },
        secretAccessKey: "s3-secret",
      })
    ).toEqual({ nested: { value: 1 } })
  })

  // A Relay keeps the tasks it stored. One from when Hearth sent a bucket's
  // keys, a path in it or a signed URL with a copy is still read, and none
  // of that is kept: the copy is all a task names now.
  it("reads a bucket's copy as an older Hearth sent it, keeping no key or URL", () => {
    const artifactId = "33333333-3333-4333-8333-333333333333"
    const stored = (destination: object) => ({
      artifactKind: "archive",
      backupId,
      destination,
      exclude: [],
      kind: "create",
      maxBytes: null,
      mode: "full",
      reason: "scheduled",
      target,
      taskId,
    })
    const scheduled = backupTaskInputSchema.parse(
      stored({
        accessKeyId: "AKIAEXAMPLE",
        allowPrivateNetwork: false,
        artifactId,
        bucket: "kiln-backups",
        endpoint: "https://s3.example.com",
        forcePathStyle: false,
        kind: "s3",
        objectKey: "team/backups/scheduled.zip",
        region: "us-east-1",
        secretAccessKey: "s3-secret",
      })
    )
    const signed = backupTaskInputSchema.parse(
      stored({
        allowPrivateNetwork: false,
        artifactId,
        headers: { "content-type": "application/zip" },
        kind: "s3",
        objectKey: "team/backups/manual.zip",
        uploadUrl: "https://s3.example.com/kiln-backups/manual.zip?X-Amz-Signature=abc",
      })
    )

    for (const input of [scheduled, signed]) {
      expect(input).toMatchObject({ destination: { artifactId, kind: "s3" } })
      expect(JSON.stringify(input)).not.toMatch(
        /AKIAEXAMPLE|s3-secret|X-Amz-Signature|team\/backups/u
      )
    }
  })
})
