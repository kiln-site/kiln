import { createServerFn } from "@tanstack/react-start"
import { Effect } from "effect"
import {
  appGitHubBuildSchema,
  appIdSchema,
  appRepositoryPathSchema,
  githubRepositoryNameSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

import { promiseEffect } from "@/effect/promise"
import { requireRelayPermission } from "@/lib/access-control"
import { appDeploymentLocks } from "@/lib/app-lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import {
  getAppDeploymentLogHandler,
  getAppDeploymentsHandler,
  getAppDeploymentSummaryHandler,
  getAppGitHubSourceFileHandler,
  recordFor,
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

export const getAppDeploymentSummary = createServerFn({ method: "GET" })
  .validator(appInputSchema)
  .handler(({ data }) => getAppDeploymentSummaryHandler(data))

export const getAppGitHubSourceFile = createServerFn({ method: "GET" })
  .validator(appInputSchema)
  .handler(({ data }) => getAppGitHubSourceFileHandler(data))

// Deploying it at once also holds what a deployment does.
const saveGitHubSource = resourceOperation({
  kind: "app",
  id: (input: z.infer<typeof saveSourceInputSchema>) => input.appId,
  name: "app.source.save",
  doing: "Changing this App's source",
  permission: () => "app.manage",
  lock: { part: "config" },
  alsoLocks: (input) =>
    input.deploy ? appDeploymentLocks(input.relayId, input.appId) : [],
  run: saveAppGitHubSourceHandler,
})

export const saveAppGitHubSource = createServerFn({ method: "POST" })
  .validator(saveSourceInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(saveGitHubSource, data, {
      user: await requireEligibleResourceUser(),
    })
  )

// Holds what deploying the deployment's App does; the App is read from the
// deployment before any lane is taken.
const redeploy = operation<z.infer<typeof deploymentInputSchema>>()({
  name: "app.redeploy",
  doing: "Deploying this App",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.flatMap((person) =>
        promiseEffect(async () => {
          const record = await recordFor(input.deploymentId)
          await requireRelayPermission({
            appId: record.appId,
            permission: "app.manage",
            relayId: record.relayId,
            user: person,
          })
          return { appId: record.appId, relayId: record.relayId, user: person }
        })
      )
    ),
  locks: ({ context }) => appDeploymentLocks(context.relayId, context.appId),
  run: ({ context, input }) =>
    promiseEffect(() => redeployAppDeploymentHandler(context.user, input)),
  audit: ({ context }) => ({
    id: context.appId,
    kind: "app",
    relayId: context.relayId,
  }),
})

export const redeployAppDeployment = createServerFn({ method: "POST" })
  .validator(deploymentInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(redeploy, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const getAppDeploymentLog = createServerFn({ method: "GET" })
  .validator(deploymentInputSchema)
  .handler(({ data }) => getAppDeploymentLogHandler(data))
