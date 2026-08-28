import { randomBytes } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import {
  databaseEngineSupportsLogicalBackups,
  databaseEngineSchema,
  databaseIdSchema,
  relayDatabaseNameSchema,
  relayIdSchema,
  relayManagedDatabaseSchema,
} from "@workspace/contracts"
import type {
  RelayControlOperation,
  RelayManagedDatabase,
} from "@workspace/contracts"
import { Effect, Result } from "effect"
import { z } from "zod"

import {
  createManagedDatabaseRecordEffect,
  listManagedDatabaseDirectoryEffect,
  listManagedDatabaseRecordsEffect,
  loadManagedDatabaseCredentialEffect,
  managedDatabaseNameExistsEffect,
  rotateManagedDatabaseCredentialEffect,
} from "@/effect/managed-databases"
import { runAppEffect } from "@/effect/runtime"
import {
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import type { AccessGrant } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  deleteDatabaseWithoutFinalBackup,
  deleteDatabaseWithFinalBackup,
} from "@/lib/final-database-deletion"
import { accessPermissions, roleHasPermission } from "@/lib/permissions"
import type { AccessPermission } from "@/lib/permissions"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { listPersistedRelays } from "@/lib/relay-registry"
import { requireAuthenticatedUser } from "@/server/auth"

const createDatabaseInputSchema = z.strictObject({
  engine: databaseEngineSchema,
  name: relayDatabaseNameSchema,
  relayId: relayIdSchema,
})
const databaseInputSchema = z.strictObject({
  databaseId: databaseIdSchema,
  relayId: relayIdSchema,
})
const databaseActionInputSchema = databaseInputSchema.extend({
  action: z.enum(["start", "stop", "restart"]),
})
const databaseNetworkInputSchema = databaseInputSchema.extend({
  connected: z.boolean(),
  instanceId: z.string().regex(/^[a-f0-9]{40}$/u),
})
const databaseImportInputSchema = databaseInputSchema.extend({
  content: z.string().max(700_000),
})

const databasePermissions = accessPermissions.filter((permission) =>
  permission.startsWith("database.")
)

const databaseEngineDetails = {
  mariadb: {
    image: "mariadb:11.8",
    internalPort: 3306,
    supportsImportExport: databaseEngineSupportsLogicalBackups("mariadb"),
  },
  mysql: {
    image: "mysql:8.4",
    internalPort: 3306,
    supportsImportExport: databaseEngineSupportsLogicalBackups("mysql"),
  },
  postgres: {
    image: "postgres:17",
    internalPort: 5432,
    supportsImportExport: databaseEngineSupportsLogicalBackups("postgres"),
  },
  redis: {
    image: "redis:8",
    internalPort: 6379,
    supportsImportExport: databaseEngineSupportsLogicalBackups("redis"),
  },
  valkey: {
    image: "valkey/valkey:8",
    internalPort: 6379,
    supportsImportExport: databaseEngineSupportsLogicalBackups("valkey"),
  },
} satisfies Record<
  ReturnType<typeof databaseEngineSchema.parse>,
  { image: string; internalPort: number; supportsImportExport: boolean }
>

type DatabaseInventoryStatus = "available" | "missing" | "unavailable"
type ManagedDatabaseListItem = RelayManagedDatabase & {
  hasCredentials: boolean
  inventoryStatus: DatabaseInventoryStatus
  permissions: Array<AccessPermission>
  relayId: string
  relayName: string
}

export const getManagedDatabaseDirectory = createServerFn({
  method: "GET",
}).handler(async () => {
  const user = await requireAuthenticatedUser()
  const [persistedRelays, grants, records] = await Promise.all([
    listPersistedRelays(),
    isPlatformAdmin(user) ? Promise.resolve([]) : listUserGrants(user.id),
    runAppEffect(
      "managedDatabases.directory",
      listManagedDatabaseDirectoryEffect()
    ),
  ])
  const relays = persistedRelays.filter((relay) => relay.enabled)
  const relayNames = new Map(relays.map((relay) => [relay.id, relay.name]))
  return records.flatMap((record) => {
    const relayName = relayNames.get(record.relayId)
    if (
      !relayName ||
      !hasDatabasePermission(
        user,
        grants,
        record.relayId,
        record.databaseId,
        "database.read"
      )
    ) {
      return []
    }
    return [
      {
        id: record.databaseId,
        name: record.name,
        relayId: record.relayId,
        relayName,
        supportsImportExport: record.supportsImportExport,
      },
    ]
  })
})

export const getManagedDatabases = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireAuthenticatedUser()
    const relays = (await listPersistedRelays()).filter(
      (relay) => relay.enabled
    )
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    const readableRelays = relays.filter((relay) =>
      hasDatabaseRelayVisibility(user, grants, relay.id)
    )
    const [records, settled] = await Promise.all([
      runAppEffect(
        "managedDatabases.records",
        listManagedDatabaseRecordsEffect()
      ),
      Promise.allSettled(
        readableRelays.map(async (relay) => ({
          databases: z
            .array(relayManagedDatabaseSchema)
            .parse(await databaseRpc(relay, "database.list", {}, 15_000)),
          relay,
        }))
      ),
    ])
    const recordsById = new Map(
      records.map((record) => [
        `${record.relayId}:${record.databaseId}`,
        record,
      ])
    )
    const readableRelaysById = new Map(
      readableRelays.map((relay) => [relay.id, relay])
    )
    const relayErrors: Array<{
      message: string
      relayId: string
      relayName: string
    }> = []
    const inventoriedDatabaseIds = new Set<string>()
    const inventoryByRelay = new Map<string, DatabaseInventoryStatus>()
    const databases: Array<ManagedDatabaseListItem> = settled.flatMap(
      (result, index) => {
        if (result.status === "rejected") {
          const relay = readableRelays[index]
          if (relay) {
            inventoryByRelay.set(relay.id, "unavailable")
            relayErrors.push({
              message:
                result.reason instanceof Error
                  ? result.reason.message
                  : "Relay database inventory is unavailable",
              relayId: relay.id,
              relayName: relay.name,
            })
          }
          return []
        }
        const { relay } = result.value
        inventoryByRelay.set(relay.id, "available")
        return result.value.databases.flatMap((database) => {
          const permissions = databasePermissions.filter((permission) =>
            hasDatabasePermission(
              user,
              grants,
              relay.id,
              database.id,
              permission
            )
          )
          if (!permissions.includes("database.read")) return []
          const recordKey = `${relay.id}:${database.id}`
          inventoriedDatabaseIds.add(recordKey)
          const record = recordsById.get(`${relay.id}:${database.id}`)
          const inventoryStatus: DatabaseInventoryStatus = "available"
          return [
            {
              ...database,
              hasCredentials: Boolean(record),
              inventoryStatus,
              permissions,
              relayId: relay.id,
              relayName: relay.name,
            },
          ]
        })
      }
    )
    for (const record of records) {
      const recordKey = `${record.relayId}:${record.databaseId}`
      if (inventoriedDatabaseIds.has(recordKey)) continue
      const relay = readableRelaysById.get(record.relayId)
      if (!relay) continue
      const permissions = databasePermissions.filter((permission) =>
        hasDatabasePermission(
          user,
          grants,
          relay.id,
          record.databaseId,
          permission
        )
      )
      if (!permissions.includes("database.read")) continue
      const inventoryStatus = inventoryByRelay.get(relay.id)
      if (!inventoryStatus || inventoryStatus === "available") {
        const details = databaseEngineDetails[record.engine]
        databases.push({
          connectedInstanceIds: [],
          containerId: null,
          createdAt: record.createdAt,
          databaseName: record.databaseName,
          engine: record.engine,
          hasCredentials: true,
          hostname: `database-${record.databaseId}`,
          id: record.databaseId,
          image: details.image,
          internalPort: details.internalPort,
          inventoryStatus: "missing",
          name: record.name,
          observedState: "failed",
          permissions,
          relayId: relay.id,
          relayName: relay.name,
          shortId: record.databaseId.slice(0, 8),
          status: "Container missing",
          supportsImportExport: details.supportsImportExport,
        })
        continue
      }
      const details = databaseEngineDetails[record.engine]
      databases.push({
        connectedInstanceIds: [],
        containerId: null,
        createdAt: record.createdAt,
        databaseName: record.databaseName,
        engine: record.engine,
        hasCredentials: true,
        hostname: `database-${record.databaseId}`,
        id: record.databaseId,
        image: details.image,
        internalPort: details.internalPort,
        inventoryStatus,
        name: record.name,
        observedState: "failed",
        permissions,
        relayId: relay.id,
        relayName: relay.name,
        shortId: record.databaseId.slice(0, 8),
        status: "Relay inventory unavailable",
        supportsImportExport: details.supportsImportExport,
      })
    }
    return {
      databases,
      relayErrors,
      relays: readableRelays.map((relay) => ({
        canCreate: hasDatabasePermission(
          user,
          grants,
          relay.id,
          undefined,
          "database.create"
        ),
        id: relay.id,
        name: relay.name,
      })),
    }
  }
)

export const getManagedDatabaseCredential = createServerFn({ method: "GET" })
  .validator(databaseInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    await requireRelayPermission({
      databaseId: data.databaseId,
      permission: "database.credentials.read",
      relayId: data.relayId,
      user,
    })
    const credential = await runAppEffect(
      "managedDatabases.credential",
      loadManagedDatabaseCredentialEffect(data.relayId, data.databaseId)
    )
    if (!credential) throw new Error("Database credentials are unavailable")
    return {
      databaseName: credential.databaseName,
      password: credential.password,
      username: credential.username,
    }
  })

export const createManagedDatabase = createServerFn({ method: "POST" })
  .validator(createDatabaseInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission({
      permission: "database.create",
      relayId: relay.id,
      user,
    })
    const nameExists = await runAppEffect(
      "managedDatabases.name.preflight",
      managedDatabaseNameExistsEffect(relay.id, data.name)
    )
    if (nameExists) {
      throw new Error(
        `A database named "${data.name}" already exists on ${relay.name}`
      )
    }
    const id = randomBytes(20).toString("hex")
    const username = `kiln_${randomBytes(6).toString("hex")}`
    const password = randomBytes(36).toString("base64url")
    const databaseName = `kiln_${id.slice(0, 12)}`
    const created = relayManagedDatabaseSchema.parse(
      await databaseRpc(
        relay,
        "database.create",
        {
          databaseName,
          engine: data.engine,
          id,
          name: data.name,
          password,
          username,
        },
        360_000,
        user.id
      )
    )
    const persisted = await promiseResult(() =>
      runAppEffect(
        "managedDatabases.record.create",
        createManagedDatabaseRecordEffect({
          createdBy: user.id,
          databaseId: id,
          databaseName,
          engine: data.engine,
          name: data.name,
          password,
          relayId: relay.id,
          username,
        })
      )
    )
    if (Result.isFailure(persisted)) {
      await ignorePromise(() =>
        databaseRpc(
          relay,
          "database.delete",
          { databaseId: id, deleteData: true },
          180_000,
          user.id
        )
      )
      throw persisted.failure
    }
    publishDatabaseChange(relay.id, true)
    return { ...created, relayId: relay.id, relayName: relay.name }
  })

export const runManagedDatabaseAction = createServerFn({ method: "POST" })
  .validator(databaseActionInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedDatabase(data, "database.power")
    const database = relayManagedDatabaseSchema.parse(
      await databaseRpc(
        relay,
        "database.action",
        { action: data.action, databaseId: data.databaseId },
        180_000,
        user.id
      )
    )
    publishDatabaseChange(relay.id, false)
    return database
  })

export const rotateManagedDatabasePassword = createServerFn({ method: "POST" })
  .validator(databaseInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedDatabase(
      data,
      "database.credentials.rotate"
    )
    const credential = await requiredCredential(data.relayId, data.databaseId)
    const nextPassword = randomBytes(36).toString("base64url")
    await databaseRpc(
      relay,
      "database.credentials.rotate",
      {
        currentPassword: credential.password,
        databaseId: data.databaseId,
        nextPassword,
        username: credential.username,
      },
      180_000,
      user.id
    )
    const persisted = await promiseResult(() =>
      runAppEffect(
        "managedDatabases.credential.persistRotation",
        rotateManagedDatabaseCredentialEffect(
          data.relayId,
          data.databaseId,
          nextPassword
        )
      )
    )
    if (Result.isFailure(persisted)) {
      await ignorePromise(() =>
        databaseRpc(
          relay,
          "database.credentials.rotate",
          {
            currentPassword: nextPassword,
            databaseId: data.databaseId,
            nextPassword: credential.password,
            username: credential.username,
          },
          180_000,
          user.id
        )
      )
      throw persisted.failure
    }
    publishDatabaseCredentialChange(relay.id, data.databaseId)
    return { rotated: true }
  })

export const updateManagedDatabaseNetwork = createServerFn({ method: "POST" })
  .validator(databaseNetworkInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedDatabase(
      data,
      "database.network.write"
    )
    await requireRelayPermission({
      instanceId: data.instanceId,
      permission: "instance.network.write",
      relayId: data.relayId,
      user,
    })
    const database = relayManagedDatabaseSchema.parse(
      await databaseRpc(
        relay,
        "database.network.write",
        {
          connected: data.connected,
          databaseId: data.databaseId,
          instanceId: data.instanceId,
        },
        30_000,
        user.id
      )
    )
    publishDatabaseChange(relay.id, false)
    return database
  })

export const exportManagedDatabase = createServerFn({ method: "POST" })
  .validator(databaseInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedDatabase(
      data,
      "database.dump.export"
    )
    const credential = await requiredCredential(data.relayId, data.databaseId)
    return z
      .object({ content: z.string(), fileName: z.string().min(1).max(180) })
      .parse(
        await databaseRpc(
          relay,
          "database.dump.export",
          {
            databaseId: data.databaseId,
            password: credential.password,
            username: credential.username,
          },
          120_000,
          user.id
        )
      )
  })

export const importManagedDatabase = createServerFn({ method: "POST" })
  .validator(databaseImportInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedDatabase(
      data,
      "database.dump.import"
    )
    const credential = await requiredCredential(data.relayId, data.databaseId)
    await databaseRpc(
      relay,
      "database.dump.import",
      {
        content: data.content,
        databaseId: data.databaseId,
        password: credential.password,
        username: credential.username,
      },
      120_000,
      user.id
    )
    return { imported: true }
  })

export const deleteManagedDatabase = createServerFn({ method: "POST" })
  .validator(databaseInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedDatabase(data, "database.delete")
    const database = (
      await runAppEffect(
        "managedDatabases.deleteTarget",
        listManagedDatabaseRecordsEffect()
      )
    ).find(
      (record) =>
        record.relayId === relay.id && record.databaseId === data.databaseId
    )
    if (!database) throw new Error("Database not found on this Relay")
    const deletion = {
      databaseId: data.databaseId,
      relay,
      requestedBy: user.id,
    }
    if (databaseEngineSupportsLogicalBackups(database.engine)) {
      await deleteDatabaseWithFinalBackup(deletion)
    } else {
      await deleteDatabaseWithoutFinalBackup(deletion)
    }
    publishDatabaseChange(relay.id, true, data.databaseId)
    return { deleted: true }
  })

function publishDatabaseChange(
  relayId: string,
  directoryChanged: boolean,
  deletedDatabaseId?: string
): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: deletedDatabaseId
      ? { databaseId: deletedDatabaseId, relayId }
      : { relayId },
    topics: deletedDatabaseId
      ? ["databases", "database-directory", "database-credentials"]
      : directoryChanged
        ? ["databases", "database-directory"]
        : ["databases"],
    type: "hearth.invalidate",
  })
}

function publishDatabaseCredentialChange(
  relayId: string,
  databaseId: string
): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { databaseId, relayId },
    topics: ["database-credentials"],
    type: "hearth.invalidate",
  })
}

async function authorizedDatabase(
  data: { databaseId: string; relayId: string },
  permission: AccessPermission
) {
  const user = await requireAuthenticatedUser()
  const relay = await requiredRelay(data.relayId)
  await requireRelayPermission({
    databaseId: data.databaseId,
    permission,
    relayId: data.relayId,
    user,
  })
  return { relay, user }
}

async function requiredCredential(relayId: string, databaseId: string) {
  const credential = await runAppEffect(
    "managedDatabases.credential.internal",
    loadManagedDatabaseCredentialEffect(relayId, databaseId)
  )
  if (!credential) throw new Error("Database credentials are unavailable")
  return credential
}

async function requiredRelay(id: string): Promise<PersistedRelay> {
  const relay = (await listPersistedRelays()).find(
    (candidate) => candidate.enabled && candidate.id === id
  )
  if (!relay) throw new Error("Relay not found")
  return relay
}

function hasDatabasePermission(
  user: AuthenticatedUser,
  grants: ReadonlyArray<AccessGrant>,
  relayId: string,
  databaseId: string | undefined,
  permission: AccessPermission
): boolean {
  if (isPlatformAdmin(user)) return true
  return grants.some(
    (grant) =>
      grant.relayId === relayId &&
      roleHasPermission(grant.role, permission) &&
      (grant.resourceType === "relay" ||
        (grant.resourceType === "database" &&
          databaseId !== undefined &&
          grant.resourceId === databaseId))
  )
}

function hasDatabaseRelayVisibility(
  user: AuthenticatedUser,
  grants: ReadonlyArray<AccessGrant>,
  relayId: string
): boolean {
  if (isPlatformAdmin(user)) return true
  return grants.some(
    (grant) =>
      grant.relayId === relayId &&
      roleHasPermission(grant.role, "database.read") &&
      (grant.resourceType === "relay" || grant.resourceType === "database")
  )
}

async function databaseRpc(
  relay: PersistedRelay,
  operation: RelayControlOperation,
  payload: unknown,
  timeoutMs: number,
  subject?: string
): Promise<unknown> {
  const { relayRpc } = await import("@/lib/relay-connection")
  return relayRpc(relay, operation, payload, timeoutMs, subject)
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
