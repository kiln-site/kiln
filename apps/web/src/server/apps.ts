import { randomBytes, randomUUID } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import {
  appConfigSchema,
  appIdSchema,
  appNameSchema,
  appServiceNameSchema,
  databaseIdSchema,
  appServiceLimitsSchema,
  relayAppLimitsV1Feature,
  relayAppProvisioningV1Feature,
  relayAppSchema,
  relayAppTerminalClaimSchema,
  relayAppTerminalRestartSchema,
  relayAppTerminalWriteSchema,
  relayAppWebRoutesWriteSchema,
  relayAppWebRouteStateSchema,
  relayIdSchema,
  webRouteHostnames,
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
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import {
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import { accessPermissions } from "@/lib/permissions"
import type { AccessPermission } from "@/lib/permissions"
import {
  abandonPreparedProvisioning,
  claimPreparedProvisioning,
} from "@/lib/provisioning.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { webRoutesForRelay } from "@/server/web-route-compatibility.server"
import { listPersistedRelays } from "@/lib/relay-registry"
import {
  appConfigPatchSchema,
  authorizedApp,
  getAppConfigHandler,
  getAppOwnerHandler,
  hasAppPermission,
  updateAppConfigHandler,
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

const cancelledSchema = z.object({ cancelled: z.boolean() })

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
    const register = () =>
      runAppEffect(
        "apps.record.create",
        createAppRecordEffect({
          appId: id,
          createdBy: user.id,
          name: data.name,
          relayId: relay.id,
        })
      )
    const { relayConnectionFeatures } = await import("@/lib/relay-connection")
    if (relayConnectionFeatures(relay.id).has(relayAppProvisioningV1Feature)) {
      // The Relay creates it in the background; it opens on its
      // provisioning page at once.
      const cancel = () =>
        databaseRpc(
          relay,
          "app.provision.cancel",
          { appId: id },
          30_000,
          user.id
        ).then((result) => cancelledSchema.parse(result).cancelled)
      const unregister = () =>
        runAppEffect("apps.record.delete", deleteAppRecordEffect(relay.id, id))
      // Recorded first, so a job the Relay holds always has an app in
      // Hearth to show it and delete it from.
      await register()
      const placeholder = await Effect.runPromise(
        promiseEffect(() =>
          databaseRpc(
            relay,
            "app.provision.prepare",
            { id, idempotencyKey: randomUUID(), name: data.name },
            30_000,
            user.id
          )
        ).pipe(
          Effect.map((value) => relayAppSchema.parse(value)),
          Effect.tapError(() => abandonPreparedProvisioning(cancel, unregister))
        )
      )
      await claimPreparedProvisioning({
        cancel,
        claim: () =>
          databaseRpc(
            relay,
            "app.provision.claim",
            { appId: id },
            30_000,
            user.id
          ),
        unconfirmed: "If it stays waiting, delete it and create it again.",
        unregister,
      })
      publishAppChange(relay.id, true)
      generateAppHostname(relay.id, id)
      return {
        id: placeholder.id,
        relayId: relay.id,
        shortId: placeholder.shortId,
      }
    }
    const created = relayAppSchema.parse(
      await databaseRpc(
        relay,
        "app.create",
        { id, name: data.name },
        60_000,
        user.id
      )
    )
    const persisted = await promiseResult(register)
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
    generateAppHostname(relay.id, id)
    return { id: created.id, relayId: relay.id, shortId: created.shortId }
  })

// A new app gets an address under a vanity domain, as game servers do. In
// the background: it calls Cloudflare, and the app opens without it.
function generateAppHostname(relayId: string, appId: string) {
  void import("@/server/web-hostname-access.server").then(
    ({ generateAppHostnameBestEffort }) =>
      generateAppHostnameBestEffort({
        relayId,
        resourceId: appId,
        resourceType: "app",
      })
  )
}

export const updateAppConfig = createServerFn({ method: "POST" })
  .validator(appConfigInputSchema)
  .handler(async ({ data }) => {
    const config = await updateAppConfigHandler(
      await requireEligibleResourceUser(),
      data
    )
    publishAppChange(data.relayId, false)
    // Which volumes the app uses shows on the Relay's Volumes page.
    if (data.config.mounts) publishRelayVolumesChange(data.relayId)
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

// Deploys the saved configuration, a GitHub app its branch's head. The
// Relay answers once the deployment starts; its log and the app's state
// follow it from there, and Hearth records how it ends.
export const deployApp = createServerFn({ method: "POST" })
  .validator(appInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedApp(data, "app.manage")
    const { startAppDeploymentEffect } =
      await import("@/lib/app-deployments.server")
    const started = await runAppEffect(
      "apps.deploy",
      startAppDeploymentEffect({
        appId: data.appId,
        relayId: relay.id,
        trigger: "manual",
        userId: user.id,
      })
    )
    publishAppChange(relay.id, false)
    return started!.app
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
    const limits = appConfigSchema.pick({ serviceLimits: true }).parse(data)
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

// Connects the app to a database or disconnects it, now and on later
// deployments. The Relay keeps the connection; connecting or disconnecting
// a database also needs that database's network permission.
export const updateAppNetwork = createServerFn({ method: "POST" })
  .validator(appNetworkInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedApp(data, "app.manage")
    const { writeDatabaseConnection } =
      await import("@/server/database-connections.server")
    return writeDatabaseConnection(user, {
      connected: data.connected,
      databaseId: data.databaseId,
      member: { id: data.appId, kind: "app" },
      relayId: relay.id,
    })
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
      routes: relayAppWebRoutesWriteSchema.shape.routes,
    })
  )
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedApp(data, "app.manage")
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
        )
    )
    publishAppChange(relay.id, false)
    // Kiln keeps the DNS records of hostnames in zones it manages.
    await syncWebRouteHostnames(resource)
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
    // Its hostnames are marked for deletion before its record goes, so a
    // Hearth that stops in between leaves them to the DNS worker, or to
    // deleting it again, rather than to nothing.
    const { deleteResourceWebHostnamesBestEffort } =
      await import("@/server/web-hostname-access.server")
    await deleteResourceWebHostnamesBestEffort({
      relayId: relay.id,
      resourceId: data.appId,
      resourceType: "app",
    })
    await runAppEffect(
      "apps.record.delete",
      deleteAppRecordEffect(relay.id, data.appId)
    )
    publishAppChange(relay.id, true)
    // Its own volumes went with it.
    publishRelayVolumesChange(relay.id)
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

function publishRelayVolumesChange(relayId: string): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { relayId },
    topics: ["relay-volumes"],
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
