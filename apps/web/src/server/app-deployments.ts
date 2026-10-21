import { createServerFn } from "@tanstack/react-start"
import {
  appGitHubBuildSchema,
  appIdSchema,
  appRepositoryPathSchema,
  githubRepositoryNameSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

import {
  getAppDeploymentLogHandler,
  getAppDeploymentsHandler,
  getAppDeploymentSummaryHandler,
  getAppGitHubSourceFileHandler,
  redeployAppDeploymentHandler,
  saveAppGitHubSourceHandler,
} from "@/server/app-deployments.server"

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

export const saveAppGitHubSource = createServerFn({ method: "POST" })
  .validator(saveSourceInputSchema)
  .handler(({ data }) => saveAppGitHubSourceHandler(data))

export const redeployAppDeployment = createServerFn({ method: "POST" })
  .validator(deploymentInputSchema)
  .handler(({ data }) => redeployAppDeploymentHandler(data))

export const getAppDeploymentLog = createServerFn({ method: "GET" })
  .validator(deploymentInputSchema)
  .handler(({ data }) => getAppDeploymentLogHandler(data))
