import { describe, expect, it } from "vite-plus/test"

import { RelayBackupError } from "../effect/errors.js"
import { backupFailureCode } from "./failure.js"

describe("backup failure codes", () => {
  it("recognizes a Backblaze B2 bucket at its storage cap", () => {
    // restic's stderr when B2 refused its lock file.
    const restic = RelayBackupError.make({
      code: "restic_command_failed",
      exitCode: 1,
      operation: "backup",
      reason:
        "Save(<lock/a3e8bb3728>) failed: client.PutObject: Cannot upload files, storage cap exceeded. See the Caps & Alerts page to increase your cap.\nunable to create lock in backend: client.PutObject: Cannot upload files, storage cap exceeded. See the Caps & Alerts page to increase your cap.",
    })
    expect(backupFailureCode(restic)).toBe("storage_full")

    // A full-archive upload, where B2 answers 403 AccessDenied.
    const upload = RelayBackupError.make({
      code: "s3_upload_failed",
      operation: "create.upload",
      reason: "The backup archive could not be uploaded to S3 storage",
      cause: new Error(
        "S3 storage returned HTTP 403: AccessDenied: Cannot upload files, storage cap exceeded."
      ),
    })
    expect(backupFailureCode(upload)).toBe("storage_full")
  })

  it("tells refused credentials from other failures", () => {
    const denied = RelayBackupError.make({
      code: "restic_command_failed",
      exitCode: 1,
      operation: "snapshots",
      reason:
        "Fatal: unable to open repository at s3:https://s3.example.com/bucket: client.BucketExists: Access Denied.",
    })
    expect(backupFailureCode(denied)).toBe("storage_access_denied")
    expect(
      backupFailureCode(
        RelayBackupError.make({
          code: "restic_command_failed",
          operation: "backup",
          reason: "Fatal: unable to save snapshot: unexpected end of JSON",
        })
      )
    ).toBeNull()
  })
})
