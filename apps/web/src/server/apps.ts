import { createServerFn } from "@tanstack/react-start"
import {
  appIdSchema,
  appNameSchema,
  appServiceNameSchema,
  brickSourceSchema,
  brickVariableValuesSchema,
  databaseIdSchema,
  instancePowerPermission,
  newDatabaseNamesShape,
  appServiceLimitsSchema,
  relayControlDeadlineMs,
  relayPowerActionSchema,
  relayAppSchema,
  relayAppTerminalClaimSchema,
  relayAppTerminalRestartSchema,
  relayAppTerminalWriteSchema,
  relayDatabaseNameSchema,
  relayIdSchema,
} from "@workspace/contracts"
import type { RelayApp } from "@workspace/contracts"
import { z } from "zod"

import {
  detachAppBrickEffect,
  renameAppRecordEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { runAppEffect } from "@/effect/runtime"
import type { AccessPermission } from "@/lib/permissions"
import { deleteConfirmationSchema } from "@/lib/delete-confirmation"
import { requireDeleteConfirmation } from "@/lib/delete-confirmation.server"
import {
  awaitResourceDeletion,
  requestResourceDeletion,
} from "@/lib/resource-deletion.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import {
  appConfigPatchSchema,
  authorizedApp,
  authorizedAppFor,
  getAppConfigHandler,
  getAppDirectoryHandler,
  getAppOwnerHandler,
  publishAppChange,
  updateAppConfigHandler,
} from "@/server/app-access"
import { requireEligibleResourceUser } from "@/server/auth"
import { askAppDeploy } from "@/server/app-deploy-ask.server"
import { resourceOperation } from "@/server/resource-operation.server"
import { createAppFor } from "@/server/app-create.server"
import { connectDatabase } from "@/server/database-connections.server"
import { databaseRpc } from "@/server/managed-database-access"
import {
  runOperationPromise,
} from "@/operations/operation"

const appInputSchema = z.strictObject({
  appId: appIdSchema,
  relayId: relayIdSchema,
})
const deployAppInputSchema = appInputSchema.extend({
  noCache: z.boolean().optional(),
})
const createAppInputSchema = z.strictObject({
  // The App Brick it is installed from, and its answers.
  brick: brickSourceSchema,
  // A database to connect it to from the start, a new one or one on its
  // Relay, whose credentials go in its environment.
  database: z
    .discriminatedUnion("kind", [
      z.strictObject({
        ...newDatabaseNamesShape,
        brick: brickSourceSchema,
        kind: z.literal("new"),
        variables: brickVariableValuesSchema.optional(),
        name: relayDatabaseNameSchema,
      }),
      z.strictObject({ id: databaseIdSchema, kind: z.literal("existing") }),
    ])
    .optional(),
  idempotencyKey: z.uuid(),
  name: appNameSchema,
  relayId: relayIdSchema,
  variables: brickVariableValuesSchema.optional(),
})
const appActionInputSchema = appInputSchema.extend({
  action: relayPowerActionSchema,
})
const appConfigInputSchema = appInputSchema.extend({
  config: appConfigPatchSchema,
})
const appLimitsInputSchema = appInputSchema.extend({
  serviceLimits: appServiceLimitsSchema,
})
const appRenameInputSchema = appInputSchema.extend({ name: appNameSchema })
const appNetworkInputSchema = appInputSchema.extend({
  connected: z.boolean(),
  databaseId: databaseIdSchema,
})

type AppInventoryStatus = "available" | "missing" | "unavailable"
export type AppListItem = RelayApp & {
  createdAt: string
  inventoryStatus: AppInventoryStatus
  name: string
  permissions: Array<AccessPermission>
  relayId: string
  relayName: string
}

export const getAppDirectory = createServerFn({ method: "GET" }).handler(
  async () => getAppDirectoryHandler(await requireEligibleResourceUser())
)

// The app's configuration. Its environment and the files it mounts carry
// secrets, so only people who can change the app see them.
export const getAppConfig = createServerFn({ method: "GET" })
  .validator(appInputSchema)
  .handler(async ({ data }) =>
    getAppConfigHandler(await requireEligibleResourceUser(), data)
  )

// Who created the app, for its Info rail. Their email only for those who can
// read the Relay's people.
export const getAppOwner = createServerFn({ method: "GET" })
  .validator(appInputSchema)
  .handler(async ({ data }) =>
    getAppOwnerHandler(await requireEligibleResourceUser(), data)
  )

// The Bricks an App can be installed from, for whoever is asked which.
export const getAppBricks = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireEligibleResourceUser()
    const { offeredAppBricks } = await import("@/server/app-bricks.server")
    return offeredAppBricks()
  }
)

export const createApp = createServerFn({ method: "POST" })
  .validator(createAppInputSchema)
  .handler(async ({ data }) =>
    createAppFor(await requireEligibleResourceUser(), data)
  )

// A host mount it adds also needs relay.files.write, which the run checks.
const changeAppConfig = resourceOperation({
  kind: "app",
  id: (input: z.infer<typeof appConfigInputSchema>) => input.appId,
  name: "app.config.update",
  lock: { part: "config" },
  doing: "Changing this App's configuration",
  permission: () => "app.manage",
  run: async (user, data) => {
    const config = await updateAppConfigHandler(user, data)
    publishAppChange(data.relayId, false)
    // Which volumes the app uses shows on the Relay's Volumes page.
    if (data.config.mounts) publishRelayVolumesChange(data.relayId)
    return { config }
  },
})

export const updateAppConfig = createServerFn({ method: "POST" })
  .validator(appConfigInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(changeAppConfig, data, {
      user: await requireEligibleResourceUser(),
    })
  )

// Stops the App following its Brick: it stays as it is, every part of it
// becomes its owner's to change, and it is offered no more of the Brick's
// revisions. There is no following it again.
const detachBrick = resourceOperation({
  kind: "app",
  id: (input: z.infer<typeof appInputSchema>) => input.appId,
  name: "app.brick.detach",
  lock: { part: "config" },
  doing: "Detaching this App from its Brick",
  permission: () => "app.manage",
  run: async (user, data) => {
    const { relay } = await authorizedAppFor(user, data, "app.manage")
    await runAppEffect(
      "apps.brick.detach",
      detachAppBrickEffect(relay.id, data.appId)
    )
    // A revision it was told of is no longer its to take.
    const { settleInstanceBrickNotificationsEffect } =
      await import("@/lib/instance-updates.server")
    await runAppEffect(
      "apps.brick.detach.settle",
      settleInstanceBrickNotificationsEffect(data.appId)
    )
    publishAppChange(relay.id, false)
    return { detached: true as const }
  },
})

export const detachAppBrick = createServerFn({ method: "POST" })
  .validator(appInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(detachBrick, data, {
      user: await requireEligibleResourceUser(),
    })
  )

// Hearth keeps the name, so renaming doesn't need the Relay. It's
// configuring the app, so it takes the permission that does.
const renameAppNow = resourceOperation({
  kind: "app",
  id: (input: z.infer<typeof appRenameInputSchema>) => input.appId,
  name: "app.rename",
  lock: { part: "name" },
  doing: "Renaming this App",
  permission: () => "app.manage",
  run: async (user, data) => {
    const { relay } = await authorizedAppFor(user, data, "app.manage")
    await runAppEffect(
      "apps.rename",
      renameAppRecordEffect(relay.id, data.appId, data.name)
    )
    publishAppChange(relay.id, true)
    return { name: data.name }
  },
})

export const renameApp = createServerFn({ method: "POST" })
  .validator(appRenameInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(renameAppNow, data, {
      user: await requireEligibleResourceUser(),
    })
  )

// Deploys the saved configuration, a GitHub app its branch's newest, once
// any deployment running ends: queued until then, joining any deploy
// already asked for. Its log and the app's state follow it from there, and
// Hearth records how it ends.
export const deployApp = createServerFn({ method: "POST" })
  .validator(deployAppInputSchema)
  .handler(async ({ data }) => {
    const queued = await runOperationPromise(
      askAppDeploy,
      {
        appId: data.appId,
        ...(data.noCache && { noCache: true }),
        relayId: data.relayId,
        trigger: "manual",
      },
      { user: await requireEligibleResourceUser() }
    )
    publishAppChange(data.relayId, false)
    return queued
  })

// Saves the app's limits and applies them to its running containers. A
// removed memory or CPU limit applies when the app next deploys.
const changeAppLimits = resourceOperation({
  kind: "app",
  id: (input: z.infer<typeof appLimitsInputSchema>) => input.appId,
  name: "app.limits.update",
  lock: { part: "config" },
  doing: "Changing this App's limits",
  permission: () => "instance.limits.write",
  run: async (user, data) => {
    const { relay } = await authorizedAppFor(
      user,
      data,
      "instance.limits.write"
    )
    const limits = { serviceLimits: data.serviceLimits }
    // Saved once the Relay applies them, so limits it refuses aren't used
    // by the next deployment, and into the config saved by then, so other
    // edits made meanwhile stay.
    const updated = relayAppSchema.parse(
      await databaseRpc(
        relay,
        "instance.limits.write",
        { id: data.appId, kind: "app", ...limits },
        relayControlDeadlineMs("instance.limits.write"),
        user.id
      )
    )
    await runAppEffect(
      "apps.limits.save",
      updateAppConfigEffect(data.relayId, data.appId, (config) => ({
        ...config,
        ...limits,
      }))
    )
    publishAppChange(relay.id, false)
    return updated
  },
})

export const updateAppLimits = createServerFn({ method: "POST" })
  .validator(appLimitsInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(changeAppLimits, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const runAppActionNow = resourceOperation({
  kind: "app",
  id: (input: z.infer<typeof appActionInputSchema>) => input.appId,
  name: "app.power",
  lock: { part: "power" },
  doing: "Changing this App's power",
  permission: (input) => instancePowerPermission(input.action),
  run: async (user, data) => {
    const { relay } = await authorizedAppFor(
      user,
      data,
      instancePowerPermission(data.action)
    )
    const app = relayAppSchema.parse(
      await databaseRpc(
        relay,
        "instance.action",
        { action: data.action, id: data.appId, kind: "app" },
        relayControlDeadlineMs("instance.action"),
        user.id
      )
    )
    publishAppChange(relay.id, false)
    return app
  },
})

export const runAppAction = createServerFn({ method: "POST" })
  .validator(appActionInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(runAppActionNow, data, {
      user: await requireEligibleResourceUser(),
    })
  )

// Connects the app to a database or disconnects it, now and on later
// deployments. The Relay keeps the connection; connecting or disconnecting
// a database also needs that database's network permission. It's the same
// change as from the database's end.
export const updateAppNetwork = createServerFn({ method: "POST" })
  .validator(appNetworkInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(
      connectDatabase,
      {
        connected: data.connected,
        databaseId: data.databaseId,
        member: { id: data.appId, kind: "app" },
        relayId: data.relayId,
      },
      { user: await requireEligibleResourceUser() }
    )
  )

export const deleteApp = createServerFn({ method: "POST" })
  .validator(
    appInputSchema.extend(deleteConfirmationSchema.shape)
  )
  .handler(async ({ data }) => {
    const { app, relay, user } = await authorizedApp(data, "app.delete")
    await requireDeleteConfirmation({
      confirmation: data.confirmation,
      name: app.name,
      password: data.password,
      user,
    })
    // Frozen, then deleted, as one operation that goes on in the
    // background if it outlasts this request. Nothing is backed up first:
    // what an App keeps is on its volumes, which stay.
    const deletion = await requestResourceDeletion({
      finalBackup: false,
      kind: "app",
      relayId: relay.id,
      resourceId: data.appId,
      storageId: null,
      user,
    })
    await awaitResourceDeletion(deletion)
    return { deleted: true }
  })

// Typing and window size go to the person's own session; the Relay rejects a
// session that isn't theirs or has ended. Output arrives through the
// terminal stream (routes/api.app-terminal.$appId.ts).
export const writeAppTerminal = createServerFn({ method: "POST" })
  .validator(relayAppTerminalWriteSchema.extend({ relayId: relayIdSchema }))
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedApp(data, "app.terminal")
    await databaseRpc(
      relay,
      "app.terminal.write",
      {
        appId: data.appId,
        data: data.data,
        service: data.service,
        sessionId: data.sessionId,
      },
      15_000,
      user.id
    )
    return { accepted: true }
  })

export const claimAppTerminal = createServerFn({ method: "POST" })
  .validator(relayAppTerminalClaimSchema.extend({ relayId: relayIdSchema }))
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedApp(data, "app.terminal")
    const claimed = await databaseRpc(
      relay,
      "app.terminal.claim",
      {
        appId: data.appId,
        attachmentId: data.attachmentId,
        cols: data.cols,
        rows: data.rows,
        service: data.service,
        sessionId: data.sessionId,
      },
      15_000,
      user.id
    )
    return z.object({ seq: z.number().int().nonnegative() }).parse(claimed)
  })

export const restartAppTerminal = createServerFn({ method: "POST" })
  .validator(relayAppTerminalRestartSchema.extend({ relayId: relayIdSchema }))
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedApp(data, "app.terminal")
    await databaseRpc(
      relay,
      "app.terminal.restart",
      { appId: data.appId, service: appServiceNameSchema.parse(data.service) },
      30_000,
      user.id
    )
    return { restarted: true }
  })

function publishRelayVolumesChange(relayId: string): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { relayId },
    topics: ["relay-volumes"],
    type: "hearth.invalidate",
  })
}
