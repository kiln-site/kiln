import { z } from "zod"

// What opens a repository of incremental backups without Kiln. restic lets
// several passwords open one repository: Kiln's own random one, which takes
// its backups, one made from Kiln's recovery code, and its destination's.

/** A backup destination's password, which opens every repository in it. */
export const backupPasswordPrefix = "kiln-bp-"

/** A new destination's password. */
export function createBackupPassword(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  return `${backupPasswordPrefix}${base64Url(bytes)}`
}

/**
 * What Kiln's password for each repository is made from: a key only its
 * recovery code gives, which doesn't give the code back, so Hearth may keep
 * it and a Relay never holds what opens Kiln's own backups. The format
 * outlives releases.
 */
export async function backupRepositoryRoot(
  platformBackupKey: string
): Promise<string> {
  const { subtle } = globalThis.crypto
  const key = await subtle.importKey(
    "raw",
    new TextEncoder().encode(platformBackupKey),
    "HKDF",
    false,
    ["deriveBits"]
  )
  const bits = await subtle.deriveBits(
    {
      hash: "SHA-256",
      info: new TextEncoder().encode("kiln backup repositories v1"),
      name: "HKDF",
      salt: new Uint8Array(),
    },
    key,
    256
  )
  return base64Url(new Uint8Array(bits))
}

/** Kiln's password for one repository. The format outlives releases. */
export async function backupRepositoryPassword(
  root: string,
  repositoryId: string
): Promise<string> {
  const { subtle } = globalThis.crypto
  const encoder = new TextEncoder()
  const key = await subtle.importKey(
    "raw",
    encoder.encode(root),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  )
  const signature = await subtle.sign("HMAC", key, encoder.encode(repositoryId))
  return base64Url(new Uint8Array(signature))
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

/**
 * The passwords that open a repository besides Kiln's own, by who holds each:
 * Kiln's administrators, through its recovery code, and the destination's
 * owner.
 */
export const backupRecoveryPasswordsSchema = z
  .array(
    z
      .object({
        holder: z.enum(["kiln", "destination"]),
        password: z.string().min(1).max(1_024),
      })
      .strict()
  )
  .max(2)

export type BackupRecoveryPasswords = z.infer<
  typeof backupRecoveryPasswordsSchema
>
