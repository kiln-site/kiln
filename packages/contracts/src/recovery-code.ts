import { Result } from "effect"
import { z } from "zod"

/**
 * Kiln's recovery code: its platform backup key, as one string to keep
 * apart from Kiln. A platform backup in format 2 carries everything else a
 * new machine needs, so that backup and this code restore Kiln. The format
 * outlives releases: change it only by adding a new prefix.
 *
 * A key that's one printable token, as Kiln generates, follows `kiln-rk-`
 * as it is. One an operator set with spaces, other characters, or past
 * 1 KiB follows `kiln-rkb-` as base64url, so every code is one line.
 */
export const recoveryCodePrefix = "kiln-rk-"
const encodedRecoveryCodePrefix = "kiln-rkb-"
const plainKey = /^[\x21-\x7e]{1,1024}$/u

export function encodeRecoveryCode(platformBackupKey: string): string {
  if (plainKey.test(platformBackupKey)) {
    return `${recoveryCodePrefix}${platformBackupKey}`
  }
  let binary = ""
  for (const byte of new TextEncoder().encode(platformBackupKey)) {
    binary += String.fromCharCode(byte)
  }
  const base64 = btoa(binary)
  return `${encodedRecoveryCodePrefix}${base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`
}

/** The platform backup key in a recovery code, or null when it isn't one. */
export function decodeRecoveryCode(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith(encodedRecoveryCodePrefix)) {
    const encoded = trimmed.slice(encodedRecoveryCodePrefix.length)
    if (!/^[\w-]+$/u.test(encoded)) return null
    return Result.getOrNull(
      Result.try(() =>
        new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(
            atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
            (character) => character.charCodeAt(0)
          )
        )
      )
    )
  }
  if (!trimmed.startsWith(recoveryCodePrefix)) return null
  const key = trimmed.slice(recoveryCodePrefix.length)
  return key ? key : null
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
  code: z
    .string()
    .min(recoveryCodePrefix.length + 1)
    // Room for any key an operator could reasonably have set, encoded.
    .max(1_048_576),
  installationId: z.string().min(1).max(120),
  scope: relayRecoveryScopeSchema,
})

export type RelayRecoveryCode = z.infer<typeof relayRecoveryCodeSchema>
