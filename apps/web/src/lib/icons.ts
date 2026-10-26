import {
  appIdSchema,
  databaseIdSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

// Icons for game servers, apps, databases, and accounts. Someone's own
// choice is shown first, then one Hearth found itself, then the kind's or
// Brick's own icon (or, for an account, its Minecraft head and initials).

/** What an icon belongs to. A user's icon is their profile picture. */
export const iconSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("server"),
    relayId: relayIdSchema,
    id: z.string().regex(/^[a-f0-9]{40}$/u),
  }),
  z.strictObject({
    kind: z.literal("app"),
    relayId: relayIdSchema,
    id: appIdSchema,
  }),
  z.strictObject({
    kind: z.literal("database"),
    relayId: relayIdSchema,
    id: databaseIdSchema,
  }),
  z.strictObject({
    kind: z.literal("user"),
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/u),
  }),
])
export type IconSubject = z.infer<typeof iconSubjectSchema>
export type InstanceIconSubject = Exclude<IconSubject, { kind: "user" }>

/** Where an icon came from, shown beside it so people know what to change. */
export const iconOriginSchema = z.discriminatedUnion("type", [
  // Uploaded from the browser.
  z.strictObject({ type: z.literal("upload") }),
  // Copied from an image on the web.
  z.strictObject({ type: z.literal("url"), url: z.string().max(2_048) }),
  // Copied from a file in the game server's or app's files, or, with a
  // service, from inside that service's container.
  z.strictObject({
    type: z.literal("file"),
    path: z.string().min(1).max(1_024),
    service: z.string().max(63).optional(),
  }),
  // Found by Hearth on the app's first domain.
  z.strictObject({ type: z.literal("site"), url: z.string().max(2_048) }),
])
export type IconOrigin = z.infer<typeof iconOriginSchema>

// Browsers shrink and convert what people choose before uploading it, so
// a saved icon is small; Hearth checks again anyway.
export const ICON_MAX_BYTES = 256 * 1024
export const ICON_MAX_DIMENSION = 512
// The size browsers draw icons at, and the most they're shrunk to.
export const ICON_TARGET_DIMENSION = 256
// What Hearth fetches from a URL for a browser to shrink.
export const ICON_SOURCE_MAX_BYTES = 4 * 1024 * 1024

/** Game servers keep their icon here, as Minecraft does. */
export const SERVER_ICON_PATH = "server-icon.png"

export function iconSubjectKey(subject: IconSubject): string {
  return subject.kind === "user"
    ? `user::${subject.id}`
    : `${subject.kind}:${subject.relayId}:${subject.id}`
}

/** Where the browser loads an icon; the digest keeps it cached until it changes. */
export function iconUrl(subject: IconSubject, digest: string): string {
  const path =
    subject.kind === "user"
      ? `/api/icons/user/${encodeURIComponent(subject.id)}`
      : `/api/icons/${subject.kind}/${encodeURIComponent(subject.relayId)}/${encodeURIComponent(subject.id)}`
  return `${path}?v=${encodeURIComponent(digest)}`
}

/** Each subject's shown icon, by `iconSubjectKey`, as its digest. */
export type IconIndex = Readonly<Record<string, string>>

export interface IconDetails {
  readonly custom: {
    readonly digest: string
    readonly origin: IconOrigin | null
    readonly updatedAt: number
  } | null
  readonly detected: {
    readonly checkedAt: number
    readonly digest: string | null
    readonly origin: IconOrigin | null
  } | null
}
