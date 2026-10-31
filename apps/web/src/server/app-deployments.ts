import { createServerFn } from "@tanstack/react-start"
import {
  appGitHubBuildSchema,
  appIdSchema,
  appRepositoryPathSchema,
  githubRepositoryNameSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

import { runOperationPromise } from "@/operations/operation"
import {
  cancelQueuedAppDeployHandler,
  getAppDeployStatesHandler,
  getAppDeploymentLogHandler,
  getAppDeploymentsHandler,
  getAppDeploymentSummaryHandler,
  getAppGitHubSourceFileHandler,
  redeployAppDeploymentHandler,
  saveAppGitHubSourceHandler,
} from "@/server/app-deployments.server"
import { requireEligibleResourceUser } from "@/server/auth"
import { resourceOperation } from "@/server/resource-operation.server"

const appInputSchema = z.strictObject({
  appId: appIdSchema,
  relayId: relayIdSchema,
})

const deploymentInputSchema = z.strictObject({ deploymentId: z.uuid() })

const cancelDeployInputSchema = appInputSchema.extend({
  operationId: z.uuid(),
})

const branchSchema = z
  .string()
  .trim()
  .min(1, "Choose a branch")
  .max(255)
  .refine((branch) => !branch.includes(".."), "Invalid branch name")

const deploymentsInputSchema = z.strictObject({
  // One app, one Relay's apps, or every app the person can read.
  appId: appIdSchema.optional(),
  before: z
    .strictObject({ id: z.uuid(), startedAt: z.iso.datetime() })
    .optional(),
  relayId: relayIdSchema.optional(),
})

const saveSourceInputSchema = appInputSchema.extend({
  autoDeploy: z.boolean(),
  branch: branchSchema,
  build: appGitHubBuildSchema,
  connectionId: z.uuid(),
  /** Deploys the branch's head once saved. */
  deploy: z.boolean(),
  path: appRepositoryPathSchema,
  repository: githubRepositoryNameSchema,
})

export const getAppDeployments = createServerFn({ method: "GET" })
  .validator(deploymentsInputSchema)
  .handler(({ data }) => getAppDeploymentsHandler(data))

// Which apps have a deploy waiting its turn or running, for their buttons.
export const getAppDeployStates = createServerFn({ method: "GET" }).handler(
  async () => getAppDeployStatesHandler(await requireEligibleResourceUser())
)

const cancelQueuedDeploy = resourceOperation({
  kind: "app",
  id: (input: z.infer<typeof cancelDeployInputSchema>) => input.appId,
  name: "app.deploy.cancel",
  doing: "Cancelling this App's queued deploy",
  permission: () => "app.manage",
  lock: "shared",
  run: cancelQueuedAppDeployHandler,
})

export const cancelQueuedAppDeploy = createServerFn({ method: "POST" })
  .validator(cancelDeployInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(cancelQueuedDeploy, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const getAppDeploymentSummary = createServerFn({ method: "GET" })
  .validator(appInputSchema)
  .handler(({ data }) => getAppDeploymentSummaryHandler(data))

export const getAppGitHubSourceFile = createServerFn({ method: "GET" })
  .validator(appInputSchema)
  .handler(({ data }) => getAppGitHubSourceFileHandler(data))

// Deploying it at once queues a deployment, which takes its own turn.
const saveGitHubSource = resourceOperation({
  kind: "app",
  id: (input: z.infer<typeof saveSourceInputSchema>) => input.appId,
  name: "app.source.save",
  doing: "Changing this App's source",
  permission: () => "app.manage",
  lock: { part: "config" },
  run: saveAppGitHubSourceHandler,
})

export const saveAppGitHubSource = createServerFn({ method: "POST" })
  .validator(saveSourceInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(saveGitHubSource, data, {
      user: await requireEligibleResourceUser(),
    })
  )

// Deploys a past deployment's commit or digest again, queued behind any
// deployment running; the deployment it asks for checks the person may.
export const redeployAppDeployment = createServerFn({ method: "POST" })
  .validator(deploymentInputSchema)
  .handler(async ({ data }) =>
    redeployAppDeploymentHandler(await requireEligibleResourceUser(), data)
  )

export const getAppDeploymentLog = createServerFn({ method: "GET" })
  .validator(deploymentInputSchema)
  .handler(({ data }) => getAppDeploymentLogHandler(data))
