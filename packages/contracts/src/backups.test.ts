import { describe, expect, it } from "vite-plus/test"

import {
  backupArchiveManifestSchema,
  relayBackupTaskSchema,
} from "./backups.js"

const createInput = {
  artifactKind: "archive",
  backupId: "00000000-0000-4000-8000-000000000004",
  destination: { kind: "local" },
  exclude: [],
  kind: "create",
  maxBytes: 100 * 1024 * 1024,
  mode: "full",
  reason: "manual",
  target: { id: "instance-1", kind: "instance" },
  taskId: "10000000-0000-4000-8000-000000000004",
} as const

const succeededCreateTask = {
  backupId: createInput.backupId,
  bytesCompleted: 1,
  bytesTotal: 1,
  createdAt: 1,
  currentArtifactId: null,
  currentPath: null,
  error: null,
  finishedAt: 2,
  input: createInput,
  inputRefreshRequired: false,
  kind: "create",
  phase: null,
  result: {
    bytes: 1,
    checksumSha256: "0".repeat(64),
    filename: "backup-0.zip",
    warnings: [],
  },
  startedAt: 1,
  status: "succeeded",
  taskId: createInput.taskId,
  updatedAt: 2,
} as const

describe("backup contracts", () => {
  it("keeps v1 archive manifests readable", () => {
    expect(
      backupArchiveManifestSchema.safeParse({
        artifactKind: "archive",
        backupId: "00000000-0000-4000-8000-000000000001",
        createdAt: "2026-08-20T12:00:00.000Z",
        formatVersion: 1,
        mode: "full",
        target: { id: "instance-1", kind: "instance" },
      }).success
    ).toBe(true)
  })

  it("reads task rows written before progress details existed", () => {
    const {
      currentArtifactId: _artifact,
      currentPath: _path,
      phase: _phase,
      ...legacyTask
    } = succeededCreateTask

    expect(relayBackupTaskSchema.parse(legacyTask)).toMatchObject({
      currentArtifactId: null,
      currentPath: null,
      phase: null,
      status: "succeeded",
    })
  })

  it("rejects task envelopes that disagree with their input or result", () => {
    expect(relayBackupTaskSchema.safeParse(succeededCreateTask).success).toBe(
      true
    )
    expect(
      relayBackupTaskSchema.safeParse({
        ...succeededCreateTask,
        backupId: "00000000-0000-4000-8000-000000000005",
      }).success
    ).toBe(false)
    expect(
      relayBackupTaskSchema.safeParse({
        ...succeededCreateTask,
        result: { warnings: [] },
      }).success
    ).toBe(false)
  })
})
