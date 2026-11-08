import type { InstanceIdKind } from "./instance-id.js"

/**
 * The one-time move from the old instance IDs to 12-character ones.
 *
 * Before it, a game server, App, database, or Tailscale network had a
 * 40-character hexadecimal ID (a game server's only unique on its Relay),
 * and a Relay's ID was its public-key fingerprint. Each old ID becomes the
 * first 12 hex characters of a SHA-256 over its kind and old identity, so
 * Hearth and every Relay arrive at the same new ID on their own, whichever
 * migrates first and whether or not they can reach each other then. Hearth
 * reserves each one in its instance directory, refusing the migration if two
 * ever coincided, and keeps the old ID beside it.
 *
 * Hashed with Web Crypto, which Node and browsers both have.
 */
export type LegacyInstanceReference =
  | { readonly kind: "relay"; readonly fingerprint: string }
  | {
      readonly kind: "server"
      /** Its Relay's fingerprint, the old Relay ID. */
      readonly relayFingerprint: string
      readonly id: string
    }
  | {
      readonly kind: Exclude<InstanceIdKind, "relay" | "server">
      readonly id: string
    }

const NAMESPACE = "kiln-instance-id-v1"

export async function migratedInstanceId(
  reference: LegacyInstanceReference
): Promise<string> {
  const parts =
    reference.kind === "relay"
      ? [reference.kind, reference.fingerprint]
      : reference.kind === "server"
        ? [reference.kind, reference.relayFingerprint, reference.id]
        : [reference.kind, reference.id]
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode([NAMESPACE, ...parts].join("\u0000"))
  )
  return Array.from(new Uint8Array(digest).subarray(0, 6), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

/** A game server's, App's, database's, or Tailscale network's old ID. */
export const LEGACY_RESOURCE_ID_PATTERN = /^[a-f0-9]{40}$/u
/** A Relay's old ID: its public-key fingerprint, base64url SHA-256. */
export const LEGACY_RELAY_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export function isLegacyResourceId(value: unknown): value is string {
  return typeof value === "string" && LEGACY_RESOURCE_ID_PATTERN.test(value)
}

export function isLegacyRelayId(value: unknown): value is string {
  return typeof value === "string" && LEGACY_RELAY_ID_PATTERN.test(value)
}

/**
 * Rewrites every old ID `replacements` knows wherever it appears in `text`:
 * in JSON, lock keys like `app:<relay>/<id>`, file roots, hostnames like
 * `database-<id>`. Only a whole old ID is replaced: a hexadecimal one never
 * inside a longer run of hex (a commit SHA or digest), a fingerprint never
 * inside a longer run of base64url.
 */
export interface LegacyIdRewriter {
  readonly size: number
  rewrite(text: string): string
}

export function legacyIdRewriter(
  replacements: ReadonlyMap<string, string>
): LegacyIdRewriter {
  const hex: Array<string> = []
  const fingerprints: Array<string> = []
  for (const id of replacements.keys()) {
    if (isLegacyResourceId(id)) hex.push(id)
    else if (isLegacyRelayId(id)) fingerprints.push(id)
  }
  const alternatives = [
    hex.length > 0
      ? `(?<![a-fA-F0-9])(?:${hex.join("|")})(?![a-fA-F0-9])`
      : null,
    fingerprints.length > 0
      ? `(?<![A-Za-z0-9_-])(?:${fingerprints.map(escapeRegExp).join("|")})(?![A-Za-z0-9_-])`
      : null,
  ].filter((part): part is string => part !== null)
  if (alternatives.length === 0) return { rewrite: (text) => text, size: 0 }
  const pattern = new RegExp(alternatives.join("|"), "gu")
  return {
    rewrite: (text) =>
      text.replace(pattern, (match) => replacements.get(match) ?? match),
    size: hex.length + fingerprints.length,
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}
