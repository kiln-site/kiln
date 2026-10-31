import { createServerFn } from "@tanstack/react-start"
import {
  appIdSchema,
  imageDigestSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

import type { AuthenticatedUser } from "@/lib/auth-session"
import { appDeploymentLocks } from "@/lib/app-lanes"
import { runOperationPromise } from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import { resourceOperation } from "@/server/resource-operation.server"
import {
  askAppImageUpdateHandler,
  recordAppImageCheckHandler,
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

// Each holds the App; deploying its update holds what a deployment does.
const imageOperation = <Input extends z.infer<typeof appInputSchema>, A>(
  name: string,
  doing: string,
  run: (user: AuthenticatedUser, input: Input) => Promise<A>,
  deploys = false
) =>
  resourceOperation({
    kind: "app",
    id: (input: Input) => input.appId,
    name,
    doing,
    permission: () => "app.manage",
    lock: "whole",
    alsoLocks: (input) =>
      deploys ? appDeploymentLocks(input.relayId, input.appId) : [],
    run,
  })

const savePolicy = imageOperation(
  "app.imageUpdates.policy",
  "Changing this App's image updates",
  (user, input: z.infer<typeof policyInputSchema>) =>
    saveAppImageUpdatePolicyHandler(user, input)
)
// Records a check asked for just before, so the App is held only while the
// answer is recorded, not while registries answer.
const recordCheck = imageOperation(
  "app.imageUpdates.check",
  "Checking this App's image",
  recordAppImageCheckHandler
)
const skipUpdate = imageOperation(
  "app.imageUpdates.skip",
  "Changing this App's image updates",
  (user, input: z.infer<typeof skipInputSchema>) =>
    skipAppImageUpdateHandler(user, input)
)
const deployUpdate = imageOperation(
  "app.imageUpdates.deploy",
  "Deploying this App",
  deployAppImageUpdateHandler,
  true
)

export const saveAppImageUpdatePolicy = createServerFn({ method: "POST" })
  .validator(policyInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(savePolicy, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const checkAppImageUpdate = createServerFn({ method: "POST" })
  .validator(appInputSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const asked = await askAppImageUpdateHandler(user, data)
    return runOperationPromise(recordCheck, { ...data, asked }, { user })
  })

export const skipAppImageUpdate = createServerFn({ method: "POST" })
  .validator(skipInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(skipUpdate, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const deployAppImageUpdate = createServerFn({ method: "POST" })
  .validator(appInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(deployUpdate, data, {
      user: await requireEligibleResourceUser(),
    })
  )
