import { createServerFn } from "@tanstack/react-start"
import { relayBrowserResourceKinds, relayIdSchema } from "@workspace/contracts"
import { z } from "zod"

const browserCapabilityInputSchema = z.object({
  instanceId: z.string().min(1).max(64),
  publicKeyJwk: z.object({
    crv: z.literal("P-256"),
    kty: z.literal("EC"),
    x: z.string().min(40).max(64),
    y: z.string().min(40).max(64),
  }),
  relayId: relayIdSchema,
  write: z.boolean().optional().default(false),
})

const relativeFilePathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !path.startsWith("/") &&
      !path.split(/[\\/]/u).includes(".."),
    "Invalid relative file path"
  )

const fileCapabilityInputSchema = browserCapabilityInputSchema.extend({
  action: z.enum(["instance.files.download", "instance.files.upload"]),
  path: relativeFilePathSchema,
  optInV2: z.boolean().optional().default(false),
})

const filePreviewCapabilityInputSchema = browserCapabilityInputSchema
  .omit({ write: true })
  .extend({ path: relativeFilePathSchema })

const browserCapabilityBatchSchema = browserCapabilityInputSchema
  .omit({ write: true })
  .extend({
    // `instanceId` is the ID of a resource of this kind.
    resourceKind: z
      .enum(relayBrowserResourceKinds)
      .optional()
      .default("instance"),
    requests: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("console"),
            optInV2: z.boolean(),
            write: z.boolean(),
          }),
          z.object({
            kind: z.literal("resources"),
            optInV2: z.boolean(),
          }),
        ])
      )
      .min(1)
      .max(2)
      .refine(
        (requests) =>
          new Set(requests.map((request) => request.kind)).size ===
          requests.length,
        "Duplicate browser capability kinds are not allowed"
      ),
  })

export const issueBrowserCapabilities = createServerFn({ method: "POST" })
  .validator(browserCapabilityBatchSchema)
  .handler(async ({ data }) => {
    const [
      { requireEligibleResourceIdentity },
      { issueBrowserCapabilitiesForRequest },
    ] = await Promise.all([
      import("@/server/auth"),
      import("@/server/relay-capability-service"),
    ])
    return issueBrowserCapabilitiesForRequest({
      authenticate: requireEligibleResourceIdentity,
      publicKeyJwk: data.publicKeyJwk,
      relayId: data.relayId,
      requests: data.requests,
      resource: { id: data.instanceId, kind: data.resourceKind },
    })
  })

export const issueFileCapability = createServerFn({ method: "POST" })
  .validator(fileCapabilityInputSchema)
  .handler(async ({ data }) => {
    const [
      { requireEligibleResourceIdentity },
      { issueFileCapabilityForRequest },
    ] = await Promise.all([
      import("@/server/auth"),
      import("@/server/relay-capability-service"),
    ])
    return issueFileCapabilityForRequest({
      action: data.action,
      authenticate: requireEligibleResourceIdentity,
      instanceId: data.instanceId,
      path: data.path,
      publicKeyJwk: data.publicKeyJwk,
      relayId: data.relayId,
      optInV2: data.optInV2,
    })
  })

/** A link the browser's media player can follow to play one file. */
export const issueFilePreviewCapability = createServerFn({ method: "POST" })
  .validator(filePreviewCapabilityInputSchema)
  .handler(async ({ data }) => {
    const [
      { requireEligibleResourceIdentity },
      { issueFilePreviewCapabilityForRequest },
    ] = await Promise.all([
      import("@/server/auth"),
      import("@/server/relay-capability-service"),
    ])
    return issueFilePreviewCapabilityForRequest({
      authenticate: requireEligibleResourceIdentity,
      instanceId: data.instanceId,
      path: data.path,
      publicKeyJwk: data.publicKeyJwk,
      relayId: data.relayId,
    })
  })
