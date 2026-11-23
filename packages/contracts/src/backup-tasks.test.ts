import { describe, expect, it } from "vite-plus/test"

import {
  backupTaskInputSchema,
  omitBackupSecrets,
  redactBackupTaskInput,
  redactRelayBackupTask,
  relayBackupTaskReportSchema,
  relayBackupTaskSchema,
  resticRepositoryFileSchema,
  resticRepositoryLocationSchema,
} from "./backups.js"

const backupId = "11111111-1111-4111-8111-111111111111"
const taskId = "22222222-2222-4222-8222-222222222222"
const target = { id: "instance-one", kind: "instance" as const }

const s3Repository = {
  kind: "s3" as const,
  repositoryId: "55555555-5555-4555-8555-555555555555",
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

  it("names a repository in a bucket and takes nothing else of the bucket", () => {
    expect(resticRepositoryLocationSchema.safeParse(s3Repository).success).toBe(
      true
    )
    for (const key of ["accessKeyId", "secretAccessKey", "repositoryPrefix"]) {
      expect(
        resticRepositoryLocationSchema.safeParse({
          ...s3Repository,
          [key]: "anything",
        }).success
      ).toBe(false)
    }
  })

  it("lets a Relay name only the files restic keeps in a repository", () => {
    const pack = "ab".repeat(32)
    for (const file of ["config", `data/${pack}`, `locks/${pack}`]) {
      expect(resticRepositoryFileSchema.safeParse(file).success).toBe(true)
    }
    for (const file of [
      "",
      "../config",
      "config/",
      "data/",
      "data/..",
      `data/../${pack}`,
      `data/${pack}/`,
      `data/${pack}\n`,
      `data/${pack.toUpperCase()}`,
      `other/${pack}`,
      `/data/${pack}`,
    ]) {
      expect(resticRepositoryFileSchema.safeParse(file).success).toBe(false)
    }
  })

  it("strips repository passwords from restic task input", () => {
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

    expect(JSON.stringify(redacted)).not.toContain("repo-secret")
    expect(
      omitBackupSecrets({
        accessKeyId: "AKIAEXAMPLE",
        nested: { repositoryPassword: "secret", value: 1 },
        secretAccessKey: "s3-secret",
      })
    ).toEqual({ nested: { value: 1 } })
  })

  it("strips S3 keys from full-upload task input", () => {
    const redacted = redactBackupTaskInput({
      artifactKind: "archive",
      backupId,
      destination: {
        accessKeyId: "AKIAEXAMPLE",
        allowPrivateNetwork: false,
        bucket: "kiln-backups",
        endpoint: "https://s3.example.com",
        forcePathStyle: false,
        kind: "s3",
        objectKey: "team/backups/scheduled.zip",
        region: "us-east-1",
        secretAccessKey: "s3-secret",
      },
      exclude: [],
      kind: "create",
      maxBytes: null,
      mode: "full",
      reason: "scheduled",
      target,
      taskId,
    })

    expect(JSON.stringify(redacted)).not.toMatch(/AKIAEXAMPLE|s3-secret/u)
  })

  // A signed link is a live capability Hearth issued: the Relay uses it and
  // sends it nowhere.
  it("sends Hearth tasks without the signed links they were given", () => {
    const signed = (name: string) =>
      `https://s3.example.test/${name}?X-Amz-Signature=signed-${name}`
    const s3 = (name: string, link: "deleteUrl" | "uploadUrl") => ({
      headers: { "content-type": "application/zip" },
      kind: "s3",
      objectKey: `team/backups/${name}.zip`,
      [link]: signed(name),
    })
    const task = (input: Record<string, unknown>) =>
      relayBackupTaskSchema.parse({
        backupId,
        bytesCompleted: 0,
        bytesTotal: null,
        createdAt: 1,
        error: null,
        finishedAt: null,
        input: { backupId, target, taskId, ...input },
        inputRefreshRequired: false,
        kind: input.kind,
        result: null,
        startedAt: null,
        status: "queued",
        taskId,
        updatedAt: 1,
      })

    for (const held of [
      task({
        artifactKind: "archive",
        destination: s3("upload", "uploadUrl"),
        exclude: [],
        kind: "create",
        maxBytes: null,
        mode: "full",
        reason: "manual",
        replicas: [s3("upload-copy", "uploadUrl")],
      }),
      task({
        kind: "restore",
        source: {
          bytes: 1,
          checksumSha256: "a".repeat(64),
          downloadUrl: signed("download"),
          kind: "remote",
        },
      }),
      task({
        destination: s3("delete", "deleteUrl"),
        kind: "delete",
        replicas: [s3("delete-copy", "deleteUrl")],
      }),
    ]) {
      const sent = redactRelayBackupTask(held)
      expect(JSON.stringify(sent)).not.toMatch(/signed-|X-Amz-Signature/u)
      expect(relayBackupTaskReportSchema.parse(sent)).toMatchObject({
        input: { kind: held.kind, target },
        taskId,
      })
    }
  })
})
