import { Schema } from "effect"
import { z } from "zod"

/**
 * Every instance — a Relay, game server, App, database, or Tailscale
 * network — has one ID: 12 lowercase hexadecimal characters, chosen at
 * random when it's created and reserved in Hearth's instance directory so
 * no two instances, live or deleted, ever share one. It's the same ID in
 * URLs, the CLI, APIs, permissions, and every record that refers to the
 * instance, and it's never shortened.
 *
 * What kind of instance it is comes from the instance, never from the ID.
 * A Relay's public-key fingerprint authenticates it; it isn't its ID.
 */
export const INSTANCE_ID_LENGTH = 12
export const INSTANCE_ID_PATTERN = /^[a-f0-9]{12}$/u
// The same, unanchored, for IDs inside keys like `app:<id>`.
export const INSTANCE_ID_SOURCE = "[a-f0-9]{12}"

export const instanceIdSchema = z.string().regex(INSTANCE_ID_PATTERN)
export const InstanceId = Schema.String.check(
  Schema.isPattern(INSTANCE_ID_PATTERN)
)

export function isInstanceId(value: unknown): value is string {
  return typeof value === "string" && INSTANCE_ID_PATTERN.test(value)
}

/**
 * A new random instance ID. The caller still reserves it, so a collision
 * picks another one rather than sharing it.
 */
export function newInstanceId(): string {
  const bytes = globalThis.crypto.getRandomValues(
    new Uint8Array(INSTANCE_ID_LENGTH / 2)
  )
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

/**
 * The kinds of instance there are. A Relay's own ID is an instance ID too.
 */
export const INSTANCE_KINDS = [
  "relay",
  "server",
  "app",
  "database",
  "tailscale",
] as const
export type InstanceIdKind = (typeof INSTANCE_KINDS)[number]
