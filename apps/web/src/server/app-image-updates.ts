import { createServerFn } from "@tanstack/react-start"
import {
  appIdSchema,
  imageDigestSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

import {
  checkAppImageUpdateHandler,
  deployAppImageUpdateHandler,
  saveAppImageUpdatePolicyHandler,
  skipAppImageUpdateHandler,
} from "@/server/app-image-updates.server"

const appInputSchema = z.strictObject({
  appId: appIdSchema,
  relayId: relayIdSchema,
})

const policyInputSchema = appInputSchema.extend({
  // Up to 90 days.
  delayHours: z.number().int().min(0).max(2_160),
  mode: z.enum(["off", "notify", "auto"]),
})

const skipInputSchema = appInputSchema.extend({ digest: imageDigestSchema })

export const saveAppImageUpdatePolicy = createServerFn({ method: "POST" })
  .validator(policyInputSchema)
  .handler(({ data }) => saveAppImageUpdatePolicyHandler(data))

export const checkAppImageUpdate = createServerFn({ method: "POST" })
  .validator(appInputSchema)
  .handler(({ data }) => checkAppImageUpdateHandler(data))

export const skipAppImageUpdate = createServerFn({ method: "POST" })
  .validator(skipInputSchema)
  .handler(({ data }) => skipAppImageUpdateHandler(data))

export const deployAppImageUpdate = createServerFn({ method: "POST" })
  .validator(appInputSchema)
  .handler(({ data }) => deployAppImageUpdateHandler(data))
