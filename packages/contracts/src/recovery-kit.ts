import { Result } from "effect"
import { z } from "zod"

/**
 * What restores Kiln on a new host, beside a platform backup.
 *
 * - A **recovery kit**: a Relay in platform mode keeps Kiln's installation
 *   record, every secret included, and prints it with
 *   `kiln-relay platform export-kit`.
 * - A **recovery key**: an installation whose secrets come from its own
 *   environment (Compose, Coolify) has only its installation ID and platform
 *   backup key to keep apart from that environment file.
 *
 * Either also travels as one line, `kiln-recovery:v1:<base64url(JSON)>`, to
 * fit one password-manager field. `kiln-relay platform import-kit` takes a
 * kit in either form. The format outlives releases: change it only by adding
 * a new version.
 */

export const recoveryTextPrefix = "kiln-recovery:v1:"

/** The kit `export-kit` prints. Hearth passes its record through as is. */
export const recoveryKitSchema = z.looseObject({
  exportedAt: z.string(),
  formatVersion: z.literal(1),
  kind: z.literal("kiln-platform-recovery-kit"),
  state: z.looseObject({ installationId: z.string().min(1).max(120) }),
})

export const recoveryKeySchema = z.object({
  formatVersion: z.literal(1),
  installationId: z.string().min(1).max(120),
  kind: z.literal("kiln-recovery-key"),
  platformBackupKey: z.string().min(1).max(1_000),
})

export type RecoveryKit = z.infer<typeof recoveryKitSchema>
export type RecoveryKey = z.infer<typeof recoveryKeySchema>

/**
 * What the Relay hosting Kiln holds (`relay.platform.recovery.read`): its
 * kit in platform mode, or else the key it was given.
 */
export const relayRecoveryMaterialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("kit"), kit: recoveryKitSchema }),
  z.object({
    kind: z.literal("key"),
    installationId: z.string().min(1).max(120),
    platformBackupKey: z.string().min(1).max(1_000),
  }),
])

export type RelayRecoveryMaterial = z.infer<typeof relayRecoveryMaterialSchema>

/** A kit or key as one line, for a password manager. */
export function encodeRecoveryText(material: RecoveryKit | RecoveryKey) {
  const bytes = new TextEncoder().encode(JSON.stringify(material))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `${recoveryTextPrefix}${btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}`
}

/**
 * The JSON inside a `kiln-recovery:v1:` line, still to be checked against
 * the schema its reader expects, or null when it isn't one.
 */
export function decodeRecoveryText(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith(recoveryTextPrefix)) return null
  const encoded = trimmed.slice(recoveryTextPrefix.length)
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return null
  return Result.getOrNull(
    Result.try((): unknown => {
      const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"))
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    })
  )
}

/** Material read from a Relay, as the kit or key its owner keeps. */
export function recoveryDocument(
  material: RelayRecoveryMaterial
): RecoveryKit | RecoveryKey {
  return material.kind === "kit"
    ? material.kit
    : {
        formatVersion: 1,
        installationId: material.installationId,
        kind: "kiln-recovery-key",
        platformBackupKey: material.platformBackupKey,
      }
}
