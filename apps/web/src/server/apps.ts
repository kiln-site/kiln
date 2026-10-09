import { randomBytes } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import {
  appConfigSchema,
  appIdSchema,
  appNameSchema,
  appServiceNameSchema,
  databaseIdSchema,
  relayAppSchema,
  relayAppTerminalClaimSchema,
  relayAppTerminalRestartSchema,
  relayAppTerminalWriteSchema,
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
  saveAppConfigEffect,
} from "@/effect/managed-apps"
import { runAppEffect } from "@/effect/runtime"
import {
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import type { AccessGrant } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { accessPermissions, grantHasPermission } from "@/lib/permissions"
import type { AccessPermission } from "@/lib/permissions"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { isRelayUpdating } from "@/lib/relay-connection"
import { listPersistedRelays } from "@/lib/relay-registry"
import { authorizedApp } from "@/server/app-access"
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
// containers; everything else waits for the next deployment.
const appConfigInputSchema = appInputSchema.extend({
  config: appConfigSchema.omit({ databaseIds: true }).partial(),
})
const appNetworkInputSchema = appInputSchema.extend({
  databaseIds: z.array(databaseIdSchema).max(32),
})

const appPermissions = accessPermissions.filter((permission) =>
  permission.startsWith("app.")
)

type AppInventoryStatus = "available" | "missing" | "unavailable"
type AppListItem = RelayApp & {
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
          name: record.name,
          relayId: record.relayId,
          relayName,
          shortId: record.appId.slice(0, 8),
        },
      ]
    })
  }
)

export const getApps = createServerFn({ method: "GET" }).handler(async () => {
  const user = await requireEligibleResourceUser()
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
  const readableRelays = relays.filter((relay) =>
    hasAppPermission(user, grants, relay.id, "app.read")
  )
  const [records, settled] = await Promise.all([
    runAppEffect("apps.records", listAppRecordsEffect()),
    Promise.allSettled(
      readableRelays.map(async (relay) => ({
        apps: z
          .array(relayAppSchema)
          .parse(await databaseRpc(relay, "app.list", {}, 15_000)),
        relay,
      }))
    ),
  ])
  const relayErrors: Array<{
    message: string
    relayId: string
    relayName: string
  }> = []
  const inventories = new Map<string, Map<string, RelayApp> | null>()
  settled.forEach((result, index) => {
    const relay = readableRelays[index]!
    if (result.status === "rejected") {
      inventories.set(relay.id, null)
      relayErrors.push({
        message:
          result.reason instanceof Error
            ? result.reason.message
            : "Relay app inventory is unavailable",
        relayId: relay.id,
        relayName: relay.name,
      })
      return
    }
    inventories.set(
      relay.id,
      new Map(result.value.apps.map((app) => [app.id, app]))
    )
  })
  const apps = records.flatMap((record): Array<AppListItem> => {
    const relay = readableRelays.find(
      (candidate) => candidate.id === record.relayId
    )
    if (!relay) return []
    const permissions = appPermissions.filter((permission) =>
      hasAppPermission(user, grants, relay.id, permission)
    )
    const inventory = inventories.get(relay.id)
    const reported = inventory?.get(record.appId)
    const common = {
      createdAt: record.createdAt,
      name: record.name,
      permissions,
      relayId: relay.id,
      relayName: relay.name,
    }
    if (reported) {
      return [{ ...reported, ...common, inventoryStatus: "available" }]
    }
    return [
      {
        ...common,
        connectedDatabaseIds: [],
        containers: [],
        dataDirectory: "",
        deployment: null,
        hostname: `app-${record.appId.slice(0, 8)}`,
        id: record.appId,
        inventoryStatus: inventory ? "missing" : "unavailable",
        network: "",
        observedState: "failed",
        shortId: record.appId.slice(0, 8),
        status: inventory ? "App missing" : "Relay inventory unavailable",
      },
    ]
  })
  return {
    apps: apps.map((app) => ({
      ...app,
      // Realtime Relay status events patch these two fields in place.
      relayStatus:
        app.inventoryStatus === "unavailable"
          ? ("unreachable" as const)
          : ("connected" as const),
      relayUpdating: isRelayUpdating(app.relayId),
    })),
    relayErrors,
    relays: readableRelays.map((relay) => ({
      canCreate: hasAppPermission(user, grants, relay.id, "app.create"),
      id: relay.id,
      name: relay.name,
    })),
  }
})

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
    const { app } = await authorizedApp(data, "app.manage")
    const config = appConfigSchema.parse({ ...app.config, ...data.config })
    await runAppEffect(
      "apps.config.save",
      saveAppConfigEffect(data.relayId, data.appId, config)
    )
    publishAppChange(data.relayId, false)
    return { config }
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
        { appId: data.appId, config: app.config, name: app.name },
        30_000,
        user.id
      )
    )
    publishAppChange(relay.id, false)
    return deployed
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
    const config = { ...app.config, databaseIds: [...after] }
    await runAppEffect(
      "apps.network.save",
      saveAppConfigEffect(relay.id, data.appId, config)
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

function hasAppPermission(
  user: AuthenticatedUser,
  grants: ReadonlyArray<AccessGrant>,
  relayId: string,
  permission: AccessPermission
): boolean {
  if (isPlatformAdmin(user)) return true
  return grants.some(
    (grant) =>
      grant.relayId === relayId &&
      grant.resourceType === "relay" &&
      grantHasPermission(grant, permission)
  )
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
