import { createServerFn } from "@tanstack/react-start"
import {
  appIdSchema,
  appNameSchema,
  appServiceNameSchema,
  databaseEngineSchema,
  databaseIdSchema,
  newDatabaseNamesShape,
  appServiceLimitsSchema,
  relayAppLimitsV1Feature,
  relayAppSchema,
  relayAppTerminalClaimSchema,
  relayAppTerminalRestartSchema,
  relayAppTerminalWriteSchema,
  relayAppWebRoutesWriteSchema,
  relayAppWebRouteStateSchema,
  relayDatabaseNameSchema,
  relayIdSchema,
  webRouteHostnames,
} from "@workspace/contracts"
import type { RelayApp } from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import {
  listAppRecordsEffect,
  renameAppRecordEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { isPlatformAdmin, listUserGrants } from "@/lib/access-control"
import { accessPermissions } from "@/lib/permissions"
import type { AccessPermission } from "@/lib/permissions"
import { deleteConfirmationSchema } from "@/lib/delete-confirmation"
import { webRouteProxySchema } from "@/lib/domain-schemas"
import { requireDeleteConfirmation } from "@/lib/delete-confirmation.server"
import {
  awaitResourceDeletion,
  requestResourceDeletion,
} from "@/lib/resource-deletion.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { webRoutesForRelay } from "@/server/web-route-compatibility.server"
import { listPersistedRelays } from "@/lib/relay-registry"
import {
  appConfigPatchSchema,
  authorizedApp,
  authorizedAppFor,
  getAppConfigHandler,
  getAppOwnerHandler,
  hasAppPermission,
  publishAppChange,
  updateAppConfigHandler,
} from "@/server/app-access"
import { requireEligibleResourceUser } from "@/server/auth"
import { askAppDeploy } from "@/server/app-deploy-ask.server"
import { resourceOperation } from "@/server/resource-operation.server"
import { createAppOperation, withNewAppIds } from "@/server/app-create.server"
import { connectDatabase } from "@/server/database-connections.server"
import { requireBackupTargetPermission } from "@/server/backup-target-access.server"
import { databaseRpc } from "@/server/managed-database-access"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { dnsKey } from "@/lib/dns-operations"
import { exclusive } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"

const appInputSchema = z.strictObject({
  appId: appIdSchema,
  relayId: relayIdSchema,
})
const deployAppInputSchema = appInputSchema.extend({
  noCache: z.boolean().optional(),
})
const createAppInputSchema = z.strictObject({
  // A database to connect it to from the start, a new one or one on its
  // Relay, whose credentials go in its environment.
  database: z
    .discriminatedUnion("kind", [
      z.strictObject({
        ...newDatabaseNamesShape,
        engine: databaseEngineSchema,
        kind: z.literal("new"),
        name: relayDatabaseNameSchema,
      }),
      z.strictObject({ id: databaseIdSchema, kind: z.literal("existing") }),
    ])
    .optional(),
  name: appNameSchema,
  relayId: relayIdSchema,
})
const appActionInputSchema = appInputSchema.extend({
  action: z.enum(["start", "stop", "restart"]),
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
      if (!relayName || !hasAppPermission(user, grants, record, "app.read")) {
        return []
      }
      return [
        {
          id: record.appId,
          createdAt: record.createdAt,
          permissions: appPermissions.filter((permission) =>
            hasAppPermission(user, grants, record, permission)
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

export const createApp = createServerFn({ method: "POST" })
  .validator(createAppInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(createAppOperation, withNewAppIds(data), {
      user: await requireEligibleResourceUser(),
    })
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
  permission: () => "app.manage",
  run: async (user, data) => {
    const { relay } = await authorizedAppFor(user, data, "app.manage")
    if (!(await relayAppLimitsSupported(relay.id))) {
      throw new Error("Update this Relay to set app limits")
    }
    const limits = { serviceLimits: data.serviceLimits }
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
  permission: () => "app.manage",
  run: async (user, data) => {
    const { relay } = await authorizedAppFor(user, data, "app.manage")
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
const appWebRoutesSchema = appInputSchema.extend({
  proxy: webRouteProxySchema.optional(),
  routes: relayAppWebRoutesWriteSchema.shape.routes,
})

const saveAppWebRoutes = operation<z.infer<typeof appWebRoutesSchema>>()({
  name: "webRoutes.app.save",
  doing: "Changing this App's web routes",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        promiseEffect(() => authorizedAppFor(person, input, "app.manage"))
      )
    ),
  locks: ({ input }) => [
    exclusive(
      dnsKey({
        relayId: input.relayId,
        resourceId: input.appId,
        resourceType: "app",
      })
    ),
  ],
  run: ({ context: user, input }) =>
    promiseEffect(() => updateAppWebRoutesHandler(user, input)),
  audit: ({ input }) => ({
    id: input.appId,
    kind: "app",
    relayId: input.relayId,
  }),
})

export const updateAppWebRoutes = createServerFn({ method: "POST" })
  .validator(appWebRoutesSchema)
  .handler(async ({ data }) =>
    runOperationPromise(saveAppWebRoutes, data, {
      user: await requireEligibleResourceUser(),
    })
  )

async function updateAppWebRoutesHandler(
  user: AuthenticatedUser,
  data: z.infer<typeof appWebRoutesSchema>
) {
  const { relay } = await authorizedAppFor(user, data, "app.manage")
  const resource = {
    relayId: relay.id,
    resourceId: data.appId,
    resourceType: "app" as const,
  }
  const { saveClaimingWebRouteHostnames, syncWebRouteHostnames } =
    await import("@/server/web-hostname-access.server")
  const state = await saveClaimingWebRouteHostnames(
    user,
    resource,
    data.routes.flatMap(webRouteHostnames),
    async () =>
      relayAppWebRouteStateSchema.parse(
        await databaseRpc(
          relay,
          "app.network.routes.write",
          {
            appId: data.appId,
            routes: webRoutesForRelay(relay.id, data.routes),
          },
          240_000,
          user.id
        )
      ),
    data.proxy
  )
  publishAppChange(relay.id, false)
  // Kiln keeps the DNS records of hostnames in zones it manages.
  await syncWebRouteHostnames(resource)
  return state
}

export const deleteApp = createServerFn({ method: "POST" })
  .validator(
    appInputSchema.extend(deleteConfirmationSchema.shape).extend({
      createBackup: z.boolean().default(true),
      storageId: z.uuid().nullable(),
    })
  )
  .handler(async ({ data }) => {
    const { app, relay, user } = await authorizedApp(data, "app.delete")
    await requireDeleteConfirmation({
      confirmation: data.confirmation,
      name: app.name,
      password: data.password,
      user,
    })
    if (data.createBackup) {
      await requireBackupTargetPermission(
        user,
        relay.id,
        { id: data.appId, kind: "app" },
        "backup.create"
      )
    }
    // Frozen, its folder and the volumes only it uses backed up if asked,
    // then deleted, as one operation that goes on in the background if it
    // outlasts this request.
    const deletion = await requestResourceDeletion({
      finalBackup: data.createBackup,
      kind: "app",
      relayId: relay.id,
      resourceId: data.appId,
      storageId: data.storageId,
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

async function relayAppLimitsSupported(relayId: string): Promise<boolean> {
  const { relayConnectionFeatures } = await import("@/lib/relay-connection")
  return relayConnectionFeatures(relayId).has(relayAppLimitsV1Feature)
}
