import type { BackupFailureCode } from "@workspace/contracts"
import { Predicate } from "effect"

import { RelayBackupError } from "../effect/errors.js"

// restic's documented exit codes.
const RESTIC_EXIT_REPOSITORY_LOCKED = 11
const RESTIC_EXIT_WRONG_PASSWORD = 12
const MAX_CAUSE_DEPTH = 4

// Checked in order: providers refuse an over-cap write with a 403, so the cap
// patterns must win over access denied.
const failurePatterns: ReadonlyArray<readonly [BackupFailureCode, RegExp]> = [
  [
    "storage_full",
    // Backblaze B2, S3 and MinIO, in that order.
    /storage cap exceeded|QuotaExceeded|XMinioStorageFull|minimum free drive threshold|InsufficientStorage|\bHTTP 507\b|quota (?:has been )?exceeded/iu,
  ],
  // Backblaze B2's daily transaction and download bandwidth caps; its
  // storage cap matched above.
  ["storage_limit_reached", /cap exceeded/iu],
  [
    "storage_bucket_missing",
    /NoSuchBucket|bucket does not exist|bucket not found/iu,
  ],
  [
    "storage_access_denied",
    /AccessDenied|Access Denied|InvalidAccessKeyId|SignatureDoesNotMatch|InvalidToken|ExpiredToken|access key id you provided does not exist|\bHTTP 40[13]\b|\b403 Forbidden\b/iu,
  ],
  ["repository_locked", /repository is already locked/iu],
  ["relay_disk_full", /no space left on device|\bENOSPC\b/iu],
  [
    "storage_unreachable",
    /no such host|connection refused|network is unreachable|i\/o timeout|tls handshake|connection reset|dial tcp|S3 backup request timed out/iu,
  ],
]

/**
 * Names why a backup task failed when the cause is one Kiln recognizes, such
 * as a storage provider refusing writes. Reads the error and the causes it
 * wraps; returns null for anything else.
 */
export function backupFailureCode(cause: unknown): BackupFailureCode | null {
  const messages: Array<string> = []
  let current: unknown = cause
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    if (current instanceof RelayBackupError) {
      if (current.exitCode === RESTIC_EXIT_WRONG_PASSWORD) {
        return "repository_password_incorrect"
      }
      if (current.exitCode === RESTIC_EXIT_REPOSITORY_LOCKED) {
        return "repository_locked"
      }
      if (current.code === "insufficient_space") return "relay_disk_full"
      messages.push(current.reason)
    } else if (current instanceof Error) {
      if (Predicate.hasProperty(current, "code") && current.code === "ENOSPC") {
        return "relay_disk_full"
      }
      messages.push(current.message)
    } else if (Predicate.isString(current)) {
      messages.push(current)
    }
    current = Predicate.hasProperty(current, "cause") ? current.cause : null
  }
  const text = messages.join("\n")
  for (const [code, pattern] of failurePatterns) {
    if (pattern.test(text)) return code
  }
  return null
}
