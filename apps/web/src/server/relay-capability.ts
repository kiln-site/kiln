import { createServerFn } from "@tanstack/react-start"
import { relayIdSchema } from "@workspace/contracts"
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

const fileCapabilityInputSchema = browserCapabilityInputSchema.extend({
  action: z.enum(["instance.files.download", "instance.files.upload"]),
  path: z
    .string()
    .min(1)
    .max(2_048)
    .refine(
      (path) =>
        !path.includes("\0") &&
        !path.startsWith("/") &&
        !path.split(/[\\/]/u).includes(".."),
      "Invalid relative file path"
    ),
})

export const issueConsoleCapability = createServerFn({ method: "POST" })
  .validator(browserCapabilityInputSchema)
  .handler(async ({ data }) => {
    const [{ requireAuthenticatedUser }, { issueConsoleCapabilityForRequest }] =
      await Promise.all([
        import("@/server/auth"),
        import("@/server/relay-capability-service"),
      ])
    return issueConsoleCapabilityForRequest({
      authenticate: requireAuthenticatedUser,
      instanceId: data.instanceId,
      publicKeyJwk: data.publicKeyJwk,
      relayId: data.relayId,
      write: data.write,
    })
  })

export const issueResourceCapability = createServerFn({ method: "POST" })
  .validator(browserCapabilityInputSchema)
  .handler(async ({ data }) => {
    const [
      { requireAuthenticatedUser },
      { issueResourceCapabilityForRequest },
    ] = await Promise.all([
      import("@/server/auth"),
      import("@/server/relay-capability-service"),
    ])
    return issueResourceCapabilityForRequest({
      authenticate: requireAuthenticatedUser,
      instanceId: data.instanceId,
      publicKeyJwk: data.publicKeyJwk,
      relayId: data.relayId,
    })
  })

export const issueFileCapability = createServerFn({ method: "POST" })
  .validator(fileCapabilityInputSchema)
  .handler(async ({ data }) => {
    const [{ requireAuthenticatedUser }, { issueFileCapabilityForRequest }] =
      await Promise.all([
        import("@/server/auth"),
        import("@/server/relay-capability-service"),
      ])
    return issueFileCapabilityForRequest({
      action: data.action,
      authenticate: requireAuthenticatedUser,
      instanceId: data.instanceId,
      path: data.path,
      publicKeyJwk: data.publicKeyJwk,
      relayId: data.relayId,
    })
  })
