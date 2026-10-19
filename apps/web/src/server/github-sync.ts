import { createServerFn } from "@tanstack/react-start"
import { relayIdSchema } from "@workspace/contracts"
import { z } from "zod"

import {
  deleteGitHubConnectionHandler,
  deleteGitHubSyncHandler,
  getGitHubSourceRepositoryCountHandler,
  getGitHubSourcesHandler,
  getGitHubSyncOverviewHandler,
  listGitHubBranchesHandler,
  listGitHubFoldersHandler,
  listGitHubRepositoriesHandler,
  refreshGitHubConnectionHandler,
  runGitHubSyncHandler,
  saveGitHubSyncHandler,
  startGitHubConnectionHandler,
} from "@/server/github-sync.server"

const connectionIdSchema = z.uuid()
const syncIdSchema = z.uuid()
const repositorySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u,
    "Choose a repository"
  )
const branchSchema = z
  .string()
  .trim()
  .min(1, "Choose a branch")
  .max(255)
  .refine((branch) => !branch.includes(".."), "Invalid branch name")

/** A folder path without slashes at either end; "" is the root. */
const folderSchema = z
  .string()
  .max(1024)
  .transform((path) =>
    path
      .trim()
      .split("/")
      .filter((segment) => segment && segment !== ".")
      .join("/")
  )
  .refine(
    (path) => !path.includes("\0") && !path.split("/").includes(".."),
    "Folders can't contain .."
  )

const includePatternsSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(50)
  .transform((patterns) => [...new Set(patterns)])

const startConnectionInputSchema = z.object({
  account: z.enum(["user", "organization"]),
  name: z.string().trim().min(3).max(34),
  organization: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u)
    .optional(),
})

const connectionInputSchema = z.object({ id: connectionIdSchema })
const repositoriesInputSchema = z.object({ connectionId: connectionIdSchema })
const branchesInputSchema = repositoriesInputSchema.extend({
  repository: repositorySchema,
})
const foldersInputSchema = branchesInputSchema.extend({ branch: branchSchema })

const saveSyncInputSchema = z.object({
  afterSync: z.enum(["none", "restart"]),
  autoSync: z.boolean(),
  branch: branchSchema,
  connectionId: connectionIdSchema,
  /** Omitted to create a sync. */
  id: syncIdSchema.optional(),
  includePatterns: includePatternsSchema,
  repository: repositorySchema,
  sourcePath: folderSchema,
  target: z.object({
    id: z.string().regex(/^[a-f0-9]{40}$/u),
    kind: z.enum(["app", "server"]),
    relayId: relayIdSchema,
  }),
  targetPath: folderSchema,
})

const syncInputSchema = z.object({ id: syncIdSchema })

export type StartGitHubConnectionInput = z.infer<
  typeof startConnectionInputSchema
>
export type GitHubBranchesInput = z.infer<typeof branchesInputSchema>
export type GitHubFoldersInput = z.infer<typeof foldersInputSchema>
export type SaveGitHubSyncInput = z.infer<typeof saveSyncInputSchema>

export const getGitHubSyncOverview = createServerFn({ method: "GET" }).handler(
  () => getGitHubSyncOverviewHandler()
)

export const getGitHubSources = createServerFn({ method: "GET" }).handler(() =>
  getGitHubSourcesHandler()
)

export const getGitHubSourceRepositoryCount = createServerFn({ method: "GET" })
  .validator(connectionInputSchema)
  .handler(({ data }) => getGitHubSourceRepositoryCountHandler(data))

// Returns the manifest the browser posts to GitHub to create the app.
export const startGitHubConnection = createServerFn({ method: "POST" })
  .validator(startConnectionInputSchema)
  .handler(({ data }) => startGitHubConnectionHandler(data))

export const refreshGitHubConnection = createServerFn({ method: "POST" })
  .validator(connectionInputSchema)
  .handler(({ data }) => refreshGitHubConnectionHandler(data))

export const deleteGitHubConnection = createServerFn({ method: "POST" })
  .validator(connectionInputSchema)
  .handler(({ data }) => deleteGitHubConnectionHandler(data))

export const listGitHubRepositories = createServerFn({ method: "GET" })
  .validator(repositoriesInputSchema)
  .handler(({ data }) => listGitHubRepositoriesHandler(data))

export const listGitHubBranches = createServerFn({ method: "GET" })
  .validator(branchesInputSchema)
  .handler(({ data }) => listGitHubBranchesHandler(data))

export const listGitHubFolders = createServerFn({ method: "GET" })
  .validator(foldersInputSchema)
  .handler(({ data }) => listGitHubFoldersHandler(data))

export const saveGitHubSync = createServerFn({ method: "POST" })
  .validator(saveSyncInputSchema)
  .handler(({ data }) => saveGitHubSyncHandler(data))

export const runGitHubSync = createServerFn({ method: "POST" })
  .validator(syncInputSchema)
  .handler(({ data }) => runGitHubSyncHandler(data))

export const deleteGitHubSync = createServerFn({ method: "POST" })
  .validator(syncInputSchema)
  .handler(({ data }) => deleteGitHubSyncHandler(data))
