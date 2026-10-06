import { describe, expect, it } from "vite-plus/test"

import {
  backupCreateTaskInputSchema,
  backupDeleteTaskInputSchema,
  backupExportTaskInputSchema,
  omitBackupSecrets,
  redactBackupTaskInput,
  resticRepositoryLocationSchema,
} from "./backups.js"

const backupId = "11111111-1111-4111-8111-111111111111"
const taskId = "22222222-2222-4222-8222-222222222222"
const createTaskId = "33333333-3333-4333-8333-333333333333"
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
  it("reads restic tasks from Hearth versions that predate repository locations", () => {
    expect(
      backupCreateTaskInputSchema.parse({
        artifactKind: "restic_snapshot",
        backupId,
        destination: { kind: "restic", repositoryPassword: "secret" },
        exclude: [],
        maxBytes: null,
        mode: "incremental",
        reason: "manual",
        target,
        taskId,
      }).destination
    ).toMatchObject({ kind: "restic", repository: { kind: "local" } })
    expect(
      backupExportTaskInputSchema.parse({
        backupId,
        snapshotId: "abcdef12",
        target,
        taskId,
        ttlMs: 60_000,
      }).repository
    ).toEqual({ kind: "local" })
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

  it("requires restic deletes to name exactly one snapshot selector", () => {
    const base = {
      backupId,
      destination: { kind: "restic" as const },
      target,
      taskId,
    }
    expect(backupDeleteTaskInputSchema.safeParse(base).success).toBe(false)
    expect(
      backupDeleteTaskInputSchema.safeParse({
        ...base,
        destination: { kind: "restic", createTaskId, snapshotId: "abcdef12" },
      }).success
    ).toBe(false)
    expect(
      backupDeleteTaskInputSchema.parse({
        ...base,
        destination: { kind: "restic", snapshotId: "abcdef12" },
      }).destination
    ).toMatchObject({ snapshotId: "abcdef12" })
    expect(
      backupDeleteTaskInputSchema.parse({
        ...base,
        destination: { kind: "restic", createTaskId },
      }).destination
    ).toMatchObject({ createTaskId })
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
})
