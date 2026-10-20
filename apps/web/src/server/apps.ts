import { randomBytes } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import {
  appConfigSchema,
  appIdSchema,
  appNameSchema,
  appServiceNameSchema,
  databaseIdSchema,
  appServiceLimitsSchema,
  relayAppLimitsV1Feature,
  relayAppSchema,
  relayAppTerminalClaimSchema,
  relayAppTerminalRestartSchema,
  relayAppTerminalWriteSchema,
  relayAppWebRouteInputSchema,
  relayAppWebRouteStateSchema,
  relayIdSchema,
} from "@workspace/contracts"
import type { RelayApp } from "@workspace/contracts"
import { Effect, Result } from "effect"
import { z } from "zod"

import {
  appNameExistsEffect,
  createAppRecordEffect,
  deleteAppRecordEffect,
  listAppRecordsEffect,
  renameAppRecordEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { runAppEffect } from "@/effect/runtime"
import {
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import { accessPermissions } from "@/lib/permissions"
import type { AccessPermission } from "@/lib/permissions"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { listPersistedRelays } from "@/lib/relay-registry"
import {
  authorizedApp,
  getAppOwnerHandler,
  getAppOwnerMinecraftProfileIdHandler,
  hasAppPermission,
} from "@/server/app-access"
import { requireEligibleResourceUser } from "@/server/auth"
import { databaseRpc, requiredRelay } from "@/server/managed-database-access"

const appInputSchema = z.strictObject({
  appId: appIdSchema,
  relayId: relayIdSchema,
})
const createAppInputSchema = z.strictObject({
  name: appNameSchema,
  relayId: relayIdSchema,
})
const appActionInputSchema = appInputSchema.extend({
  action: z.enum(["start", "stop", "restart"]),
})
// Databases change through the network, which also connects running
// containers, and limits through their own update, which applies them to
// running ones; everything else waits for the next deployment.
const appConfigInputSchema = appInputSchema.extend({
  config: appConfigSchema
    .omit({ databaseIds: true, diskLimitBytes: true, serviceLimits: true })
    .partial(),
})
const appLimitsInputSchema = appInputSchema.extend({
  diskLimitBytes: appConfigSchema.shape.diskLimitBytes.unwrap(),
  serviceLimits: appServiceLimitsSchema,
})
const appRenameInputSchema = appInputSchema.extend({ name: appNameSchema })
const appNetworkInputSchema = appInputSchema.extend({
  databaseIds: z.array(databaseIdSchema).max(32),
})

const appPermissions = accessPermissions.filter((permission) =>
  permission.startsWith("app.")
)

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
  async () => {
    const user = await requireEligibleResourceUser()
    const [persistedRelays, grants, records] = await Promise.all([
      listPersistedRelays(),
      isPlatformAdmin(user) ? Promise.resolve([]) : listUserGrants(user.id),
      runAppEffect("apps.directory", listAppRecordsEffect()),
    ])
    const relayNames = new Map(
      persistedRelays
        .filter((relay) => relay.enabled)
        .map((relay) => [relay.id, relay.name])
    )
    return records.flatMap((record) => {
      const relayName = relayNames.get(record.relayId)
      if (
        !relayName ||
        !hasAppPermission(user, grants, record.relayId, "app.read")
      ) {
        return []
      }
      return [
        {
          id: record.appId,
          createdAt: record.createdAt,
          permissions: appPermissions.filter((permission) =>
            hasAppPermission(user, grants, record.relayId, permission)
          ),
          name: record.name,
          relayId: record.relayId,
          relayName,
          shortId: record.appId.slice(0, 8),
        },
      ]
    })
  }
)

// The app's configuration. Its environment carries secrets, so only people
// who can change the app see it.
export const getAppConfig = createServerFn({ method: "GET" })
  .validator(appInputSchema)
  .handler(async ({ data }) => {
    const { app, user } = await authorizedApp(data, "app.read")
    const canManage = await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          requireRelayPermission({
            permission: "app.manage",
            relayId: data.relayId,
            user,
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false)
      )
    )
    return {
      config: canManage ? app.config : { ...app.config, environment: "" },
      environmentHidden: !canManage,
    }
  })

// Who created the app, for its Info rail. Their email only for those who can
// read the Relay's people.
export const getAppOwner = createServerFn({ method: "GET" })
  .validator(appInputSchema)
  .handler(async ({ data }) =>
    getAppOwnerHandler(await requireEligibleResourceUser(), data)
  )

export const getAppOwnerMinecraftProfileId = createServerFn({ method: "GET" })
  .validator(appInputSchema)
  .handler(async ({ data }) =>
    getAppOwnerMinecraftProfileIdHandler(
      await requireEligibleResourceUser(),
      data
    )
  )

export const createApp = createServerFn({ method: "POST" })
  .validator(createAppInputSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission({
      permission: "app.create",
      relayId: relay.id,
      user,
    })
    const nameExists = await runAppEffect(
      "apps.name.preflight",
      appNameExistsEffect(relay.id, data.name)
    )
    if (nameExists) {
      throw new Error(
        `An app named "${data.name}" already exists on ${relay.name}`
      )
    }
    const id = randomBytes(20).toString("hex")
    const created = relayAppSchema.parse(
      await databaseRpc(
        relay,
        "app.create",
        { id, name: data.name },
        60_000,
        user.id
      )
    )
    const persisted = await promiseResult(() =>
      runAppEffect(
        "apps.record.create",
        createAppRecordEffect({
          appId: id,
          createdBy: user.id,
          name: data.name,
          relayId: relay.id,
        })
      )
    )
    if (Result.isFailure(persisted)) {
      await ignorePromise(() =>
        databaseRpc(
          relay,
          "app.delete",
          { appId: id, deleteData: true },
          180_000,
          user.id
        )
      )
      throw persisted.failure
    }
    publishAppChange(relay.id, true)
    return { id: created.id, relayId: relay.id, shortId: created.shortId }
  })

export const updateAppConfig = createServerFn({ method: "POST" })
  .validator(appConfigInputSchema)
  .handler(async ({ data }) => {
    await authorizedApp(data, "app.manage")
    // Only the fields this edit changes, into the config saved now.
    const config = await runAppEffect(
      "apps.config.save",
      updateAppConfigEffect(data.relayId, data.appId, (current) =>
        appConfigSchema.parse({ ...current, ...data.config })
      )
    )
    publishAppChange(data.relayId, false)
    return { config }
  })

// Hearth keeps the name, so renaming doesn't need the Relay. It's
// configuring the app, so it takes the permission that does.
export const renameApp = createServerFn({ method: "POST" })
  .validator(appRenameInputSchema)
  .handler(async ({ data }) => {
    const { relay } = await authorizedApp(data, "app.manage")
    await runAppEffect(
      "apps.rename",
      renameAppRecordEffect(relay.id, data.appId, data.name)
    )
    publishAppChange(relay.id, true)
    return { name: data.name }
  })

// Deploys the saved configuration. The Relay answers once the deployment
// starts; its log and the app's state follow it from there.
export const deployApp = createServerFn({ method: "POST" })
  .validator(appInputSchema)
  .handler(async ({ data }) => {
    const { app, relay, user } = await authorizedApp(data, "app.manage")
    const deployed = relayAppSchema.parse(
      await databaseRpc(
        relay,
        "app.deploy",
        {
          appId: data.appId,
          config: await relayAppConfig(relay.id, app.config),
          name: app.name,
        },
        30_000,
        user.id
      )
    )
    publishAppChange(relay.id, false)
    return deployed
  })

// Saves the app's limits and applies them to its running containers. A
// removed memory or CPU limit applies when the app next deploys.
export const updateAppLimits = createServerFn({ method: "POST" })
  .validator(appLimitsInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedApp(data, "app.manage")
    if (!(await relayAppLimitsSupported(relay.id))) {
      throw new Error("Update this Relay to set app limits")
    }
    const limits = appConfigSchema
      .pick({ diskLimitBytes: true, serviceLimits: true })
      .parse(data)
    // Saved once the Relay applies them, so limits it refuses aren't used
    // by the next deployment, and into the config saved by then, so other
    // edits made meanwhile stay.
    const updated = relayAppSchema.parse(
      await databaseRpc(
        relay,
        "app.limits.write",
        { appId: data.appId, ...limits },
        60_000,
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
  })

export const runAppAction = createServerFn({ method: "POST" })
  .validator(appActionInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedApp(data, "app.manage")
    const app = relayAppSchema.parse(
      await databaseRpc(
        relay,
        "app.action",
        { action: data.action, appId: data.appId },
        180_000,
        user.id
      )
    )
    publishAppChange(relay.id, false)
    return app
  })

// Connects the app to exactly these databases, now and on later deployments.
// Each database connected or disconnected needs its own network permission.
export const updateAppNetwork = createServerFn({ method: "POST" })
  .validator(appNetworkInputSchema)
  .handler(async ({ data }) => {
    const { app, relay, user } = await authorizedApp(data, "app.manage")
    const before = new Set(app.config.databaseIds)
    const after = new Set(data.databaseIds)
    for (const databaseId of new Set([...before, ...after])) {
      if (before.has(databaseId) === after.has(databaseId)) continue
      await requireRelayPermission({
        databaseId,
        permission: "database.network.write",
        relayId: relay.id,
        user,
      })
    }
    const config = await runAppEffect(
      "apps.network.save",
      updateAppConfigEffect(relay.id, data.appId, (current) => ({
        ...current,
        databaseIds: [...after],
      }))
    )
    const updated = relayAppSchema.parse(
      await databaseRpc(
        relay,
        "app.network.write",
        { appId: data.appId, databaseIds: config.databaseIds },
        30_000,
        user.id
      )
    )
    publishAppChange(relay.id, false)
    return updated
  })

export const getAppWebRoutes = createServerFn({ method: "GET" })
  .validator(appInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedApp(data, "app.read")
    return relayAppWebRouteStateSchema.parse(
      await databaseRpc(
        relay,
        "app.network.routes.read",
        { appId: data.appId },
        30_000,
        user.id
      )
    )
  })

// Saves the app's routes. Bundled Traefik serves them right away; an
// external Traefik once a deploy labels the app's containers.
export const updateAppWebRoutes = createServerFn({ method: "POST" })
  .validator(
    appInputSchema.extend({
      routes: z.array(relayAppWebRouteInputSchema).max(16),
    })
  )
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedApp(data, "app.manage")
    const state = relayAppWebRouteStateSchema.parse(
      await databaseRpc(
        relay,
        "app.network.routes.write",
        { appId: data.appId, routes: data.routes },
        240_000,
        user.id
      )
    )
    publishAppChange(relay.id, false)
    return state
  })

export const deleteApp = createServerFn({ method: "POST" })
  .validator(appInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedApp(data, "app.delete")
    const removed = await promiseResult(() =>
      databaseRpc(
        relay,
        "app.delete",
        { appId: data.appId, deleteData: true },
        180_000,
        user.id
      )
    )
    // An app already gone from the Relay still loses its record.
    if (
      Result.isFailure(removed) &&
      !(
        removed.failure instanceof Error &&
        removed.failure.message.includes("App not found")
      )
    ) {
      throw removed.failure
    }
    await runAppEffect(
      "apps.record.delete",
      deleteAppRecordEffect(relay.id, data.appId)
    )
    publishAppChange(relay.id, true)
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

function publishAppChange(relayId: string, directoryChanged: boolean): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { relayId },
    topics: directoryChanged ? ["apps", "app-directory"] : ["apps"],
    type: "hearth.invalidate",
  })
}

function promiseResult<TResult>(run: () => Promise<TResult>) {
  return Effect.runPromise(
    Effect.result(Effect.tryPromise({ try: run, catch: (cause) => cause }))
  )
}

async function ignorePromise(run: () => Promise<unknown>): Promise<void> {
  await Effect.runPromise(
    Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(Effect.ignore)
  )
}

async function relayAppLimitsSupported(relayId: string): Promise<boolean> {
  const { relayConnectionFeatures } = await import("@/lib/relay-connection")
  return relayConnectionFeatures(relayId).has(relayAppLimitsV1Feature)
}

// The config as the Relay takes it. A Relay without app limits refuses
// their fields, so it gets the config without them, or none if it would
// have to drop limits.
async function relayAppConfig(
  relayId: string,
  config: z.infer<typeof appConfigSchema>
) {
  if (await relayAppLimitsSupported(relayId)) return config
  const { diskLimitBytes, serviceLimits, ...rest } = config
  if (diskLimitBytes !== null || Object.keys(serviceLimits).length > 0) {
    throw new Error("Update this Relay to deploy an app with limits")
  }
  return rest
}
