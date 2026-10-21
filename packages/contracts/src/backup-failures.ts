import { Result } from "effect"

import { backupFailureCodes, type BackupFailureCode } from "./backups.js"

export interface BackupFailureDescription {
  /** A short summary that fits a table cell. */
  title: string
  /** What happened and what to do about it. */
  detail: string
  /**
   * The refusal came from outside Kiln, such as a storage provider's cap,
   * so it's fixed there.
   */
  external: boolean
}

// Hosts of S3-compatible providers people commonly point Kiln at, so a
// failure can name the provider that refused it.
const storageProviders: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:^|\.)backblazeb2\.com$/u, "Backblaze B2"],
  [/(?:^|\.)r2\.cloudflarestorage\.com$/u, "Cloudflare R2"],
  [/(?:^|\.)amazonaws\.com$/u, "Amazon S3"],
  [/(?:^|\.)wasabisys\.com$/u, "Wasabi"],
  [/(?:^|\.)digitaloceanspaces\.com$/u, "DigitalOcean Spaces"],
  [/(?:^|\.)storage\.googleapis\.com$/u, "Google Cloud Storage"],
  [/(?:^|\.)your-objectstorage\.com$/u, "Hetzner Object Storage"],
  [/(?:^|\.)linodeobjects\.com$/u, "Akamai Object Storage"],
]

/** The provider behind an S3 endpoint, when it's a well-known one. */
export function backupStorageProviderName(
  endpoint: string | null | undefined
): string | null {
  if (!endpoint) return null
  const url = Result.try(() => new URL(endpoint))
  if (Result.isFailure(url)) return null
  const hostname = url.success.hostname.toLowerCase()
  for (const [pattern, name] of storageProviders) {
    if (pattern.test(hostname)) return name
  }
  return null
}

/** A failure code this Hearth knows, or null for none or a newer one. */
export function knownBackupFailureCode(
  code: string | null | undefined
): BackupFailureCode | null {
  return backupFailureCodes.find((known) => known === code) ?? null
}

/**
 * Explains a backup failure to the user. `provider` names the storage
 * provider the backup lives on, when Hearth knows it.
 */
export function describeBackupFailure(
  code: BackupFailureCode,
  provider: string | null
): BackupFailureDescription {
  const storage = provider ?? "The storage provider"
  const backblaze = provider === "Backblaze B2"
  switch (code) {
    case "storage_full":
      return {
        title: provider
          ? `${provider} storage cap reached`
          : "Storage cap reached",
        detail: `${storage} refused the upload because the bucket reached its storage cap or quota. Raise the cap ${backblaze ? "on Backblaze's Caps & Alerts page" : "in the provider's account"}, or free space there. Deleting backups also needs a small upload, so raise the cap before deleting.`,
        external: true,
      }
    case "storage_limit_reached":
      return {
        title: provider
          ? `${provider} account limit reached`
          : "Storage account limit reached",
        detail: `${storage} refused the request because an account limit, such as a daily transaction or download cap, was reached. Raise it ${backblaze ? "on Backblaze's Caps & Alerts page" : "in the provider's account"}, or wait for it to reset.`,
        external: true,
      }
    case "storage_access_denied":
      return {
        title: provider ? `${provider} denied access` : "Storage denied access",
        detail: `${storage} refused the destination's access key. Check the key and its permissions in the destination's settings.`,
        external: true,
      }
    case "storage_bucket_missing":
      return {
        title: "Bucket not found",
        detail: `${storage} says the destination's bucket doesn't exist. Check the bucket name in the destination's settings.`,
        external: true,
      }
    case "storage_unreachable":
      return {
        title: provider ? `Couldn't reach ${provider}` : "Couldn't reach storage",
        detail:
          "The Relay couldn't connect to the storage endpoint. Check the destination's endpoint and the Relay's network.",
        // The Relay's own network is as likely as the provider.
        external: false,
      }
    case "repository_locked":
      return {
        title: "Backup repository is locked",
        detail:
          "Another restic process holds this backup repository's lock. If the Relay restarted during a backup, its lock expires within 30 minutes; try again then.",
        external: false,
      }
    case "repository_password_incorrect":
      return {
        title: "Repository password rejected",
        detail:
          "The backup repository rejected its password, so its snapshots can't be read.",
        external: false,
      }
    case "relay_disk_full":
      return {
        title: "Relay disk is full",
        detail:
          "The Relay's node ran out of disk space. Free some space and try again.",
        external: false,
      }
    case "timed_out":
      return {
        title: "Timed out",
        detail:
          "The task ran longer than the Relay's backup timeout, KILN_BACKUP_TIMEOUT.",
        external: false,
      }
  }
}
