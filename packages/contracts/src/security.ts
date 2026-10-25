import { z } from "zod"

// What a Relay tells Hearth about the software on its host, so Hearth can
// check it for known vulnerabilities. The Relay inventories its host and each
// image once, with Syft; Hearth keeps the inventories and checks them again
// whenever its vulnerability data changes, so nothing is scanned twice and
// an unreachable Relay is still covered by what it last reported.

/** A local image's content-addressed ID, which changes with what it holds. */
export const securityImageIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)

export const securityResourceTypeSchema = z.enum([
  "relay",
  "instance",
  "database",
  "app",
])
export type SecurityResourceType = z.infer<typeof securityResourceTypeSchema>

/**
 * One container on the Relay's host and the image it was created from. Kiln's
 * own services (the Relay, its proxy, a platform install's Hearth) belong to
 * the Relay, with `component` naming the service; an app's belong to the app,
 * with `component` naming its service.
 */
export const relaySecurityContainerSchema = z
  .object({
    component: z.string().max(128).nullable(),
    image: z.string().max(512),
    imageId: securityImageIdSchema,
    resource: z
      .object({
        id: z.string().min(1).max(64),
        type: securityResourceTypeSchema,
      })
      .strict(),
    running: z.boolean(),
  })
  .strict()
export type RelaySecurityContainer = z.infer<
  typeof relaySecurityContainerSchema
>

export const relaySecurityTargetsSchema = z
  .object({
    containers: z.array(relaySecurityContainerSchema).max(2_000),
    host: z
      .object({
        architecture: z.string().max(64).nullable(),
        docker: z.string().max(64).nullable(),
        kernel: z.string().max(128).nullable(),
        os: z.string().max(255).nullable(),
      })
      .strict(),
    // The inventory tool, or null when this Relay can't inventory.
    scanner: z.string().max(64).nullable(),
  })
  .strict()
export type RelaySecurityTargets = z.infer<typeof relaySecurityTargetsSchema>

export const relaySecurityTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("host") }).strict(),
  z
    .object({
      image: z.string().max(512),
      imageId: securityImageIdSchema,
      kind: z.literal("image"),
    })
    .strict(),
])
export type RelaySecurityTarget = z.infer<typeof relaySecurityTargetSchema>

/** Raw bytes in one inventory chunk, so a chunk fits a control frame. */
export const relaySecurityInventoryChunkBytes = 512 * 1024
/**
 * The largest inventory Hearth accepts, as JSON before it's gzipped. The
 * Relay sends Syft's packages without the files each installed, which is a
 * few MiB for a host with thousands of packages, so Hearth can read it
 * whole without a Relay being able to run it out of memory.
 */
export const relaySecurityInventoryMaxBytes = 32 * 1024 * 1024

/**
 * Reads a target's inventory from `offset`. The Relay inventories the target
 * first when it has none collected after `collectedAfter`, so Hearth asks for
 * the first chunk with the age it accepts and the rest with the
 * `collectedAt` the first answered.
 */
export const relaySecurityInventoryRequestSchema = z
  .object({
    collectedAfter: z.number().int().nonnegative().nullable(),
    offset: z.number().int().nonnegative(),
    target: relaySecurityTargetSchema,
  })
  .strict()
export type RelaySecurityInventoryRequest = z.infer<
  typeof relaySecurityInventoryRequestSchema
>

export const relaySecurityInventoryResponseSchema = z.discriminatedUnion(
  "status",
  [
    // A gzipped Syft JSON document, in chunks.
    z
      .object({
        collectedAt: z.number().int().nonnegative(),
        // Base64 of up to `relaySecurityInventoryChunkBytes`.
        data: z
          .string()
          .max(Math.ceil(relaySecurityInventoryChunkBytes / 3) * 4),
        generator: z.string().max(64),
        offset: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        size: z.number().int().positive().max(relaySecurityInventoryMaxBytes),
        status: z.literal("ready"),
      })
      .strict(),
    // The host is busy; Hearth asks again later.
    z.object({ status: z.literal("busy") }).strict(),
    z
      .object({ error: z.string().max(1_000), status: z.literal("failed") })
      .strict(),
  ]
)
export type RelaySecurityInventoryResponse = z.infer<
  typeof relaySecurityInventoryResponseSchema
>
