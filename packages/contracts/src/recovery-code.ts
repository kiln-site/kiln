import { z } from "zod"

/**
 * Kiln's recovery code: its platform backup key, as one string to keep
 * apart from Kiln. A platform backup in format 2 carries everything else a
 * new machine needs, so that backup and this code restore Kiln. The format
 * outlives releases: change it only by adding a new prefix.
 */
export const recoveryCodePrefix = "kiln-rk-"

export function encodeRecoveryCode(platformBackupKey: string): string {
  return `${recoveryCodePrefix}${platformBackupKey}`
}

/** The platform backup key in a recovery code, or null when it isn't one. */
export function decodeRecoveryCode(text: string): string | null {
  const code = text.trim()
  return code.startsWith(recoveryCodePrefix) &&
    code.length > recoveryCodePrefix.length
    ? code.slice(recoveryCodePrefix.length)
    : null
}

/**
 * What a Relay holds to restore Kiln: the code for a Kiln it installed,
 * whose backups carry the rest, or for one whose other secrets live in the
 * operator's own environment file, which they must keep too.
 */
export const relayRecoveryScopeSchema = z.enum(["installation", "environment"])

export type RelayRecoveryScope = z.infer<typeof relayRecoveryScopeSchema>

/** The Relay hosting Kiln's answer to `relay.platform.recovery.read`. */
export const relayRecoveryCodeSchema = z.object({
  code: z.string().min(recoveryCodePrefix.length + 1),
  installationId: z.string().min(1).max(120),
  scope: relayRecoveryScopeSchema,
})

export type RelayRecoveryCode = z.infer<typeof relayRecoveryCodeSchema>
