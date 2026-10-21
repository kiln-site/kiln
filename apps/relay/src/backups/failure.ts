import {
  backupFailureCodeFromMessage,
  type BackupFailureCode,
} from "@workspace/contracts"
import { Predicate } from "effect"

import { RelayBackupError } from "../effect/errors.js"

// restic's documented exit codes.
const RESTIC_EXIT_REPOSITORY_LOCKED = 11
const RESTIC_EXIT_WRONG_PASSWORD = 12
const MAX_CAUSE_DEPTH = 4

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
  return backupFailureCodeFromMessage(messages.join("\n"))
}
