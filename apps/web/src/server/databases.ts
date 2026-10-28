import { randomBytes, randomUUID } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import {
  databaseEngineSupportsBrowsing,
  databaseEngineSupportsLogicalBackups,
  databaseEngineSchema,
  databaseMutateInputSchema,
  databaseMutateResultSchema,
  databaseOverviewSchema,
  databaseQueryInputSchema,
  databaseQueryResultSchema,
  databaseRowsInputSchema,
  databaseRowsSchema,
  databaseIdSchema,
  relayDatabaseNameSchema,
  relayIdSchema,
  relayDatabaseTerminalClaimSchema,
  relayDatabaseTerminalRestartSchema,
  relayDatabaseTerminalWriteSchema,
  relayDatabaseContainerSchema,
  relayDatabaseDumpFilesV1Feature,
  relayDatabaseImportFileSchema,
  relayDatabaseLimitsV1Feature,
  relayDatabaseProvisioningV1Feature,
  relayManagedDatabaseSchema,
  resourceLimitsInputSchema,
} from "@workspace/contracts"
import type { RelayManagedDatabase } from "@workspace/contracts"
import { Effect, Result } from "effect"
import { z } from "zod"

import {
  createManagedDatabaseRecordEffect,
  deleteManagedDatabaseRecordEffect,
  listManagedDatabaseDirectoryEffect,
  listManagedDatabaseRecordsEffect,
  loadManagedDatabaseCredentialEffect,
  managedDatabaseNameExistsEffect,
  renameManagedDatabaseRecordEffect,
  rotateManagedDatabaseCredentialEffect,
} from "@/effect/managed-databases"
import { promiseEffect } from "@/effect/promise"
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
import { accessPermissions, grantHasPermission } from "@/lib/permissions"
import type { AccessPermission } from "@/lib/permissions"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import {
  abandonPreparedProvisioning,
  claimPreparedProvisioning,
} from "@/lib/provisioning.server"
import { listPersistedRelays } from "@/lib/relay-registry"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  authorizedDatabase,
  databaseRpc,
  requiredCredential,
  requiredRelay,
} from "@/server/managed-database-access"

const createDatabaseInputSchema = z.strictObject({
  engine: databaseEngineSchema,
  name: relayDatabaseNameSchema,
  relayId: relayIdSchema,
})
const databaseInputSchema = z.strictObject({
  databaseId: databaseIdSchema,
  relayId: relayIdSchema,
})
const cancelledSchema = z.object({ cancelled: z.boolean() })
const databaseActionInputSchema = databaseInputSchema.extend({
  action: z.enum(["start", "stop", "restart"]),
})
const databaseLimitsInputSchema = databaseInputSchema.extend({
  limits: resourceLimitsInputSchema,
})
const databaseRenameInputSchema = databaseInputSchema.extend({
  name: relayDatabaseNameSchema,
})
const databaseNetworkInputSchema = databaseInputSchema.extend({
  connected: z.boolean(),
  instanceId: z.string().regex(/^[a-f0-9]{40}$/u),
})
const databaseRowsRequestSchema = databaseInputSchema.extend({
  request: databaseRowsInputSchema,
})
const databaseQueryRequestSchema = databaseInputSchema.extend({
  readOnly: z.boolean(),
  request: databaseQueryInputSchema,
})
const databaseMutateRequestSchema = databaseInputSchema.extend({
  request: databaseMutateInputSchema,
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
export type ManagedDatabaseListItem = RelayManagedDatabase & {
  hasCredentials: boolean
  inventoryStatus: DatabaseInventoryStatus
  permissions: Array<AccessPermission>
  relayId: string
  relayName: string
}

export const getManagedDatabaseDirectory = createServerFn({
  method: "GET",
}).handler(async () => {
  const user = await requireEligibleResourceUser()
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
        createdAt: record.createdAt,
        engine: record.engine,
        databaseName: record.databaseName,
        hostname: `database-${record.databaseId}`,
        image: databaseEngineDetails[record.engine].image,
        internalPort: databaseEngineDetails[record.engine].internalPort,
        hasCredentials: true,
        permissions: databasePermissions.filter((permission) =>
          hasDatabasePermission(
            user,
            grants,
            record.relayId,
            record.databaseId,
            permission
          )
        ),
        id: record.databaseId,
        name: record.name,
        relayId: record.relayId,
        relayName,
        shortId: record.databaseId.slice(0, 8),
        supportsImportExport: record.supportsImportExport,
      },
    ]
  })
})

export const getManagedDatabaseCredential = createServerFn({ method: "GET" })
  .validator(databaseInputSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
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
      hostname: `database-${credential.databaseId}`,
      internalPort: databaseEngineDetails[credential.engine].internalPort,
      password: credential.password,
      username: credential.username,
    }
  })

// The database's container: its name, data folder, and volume size. Docker
// measures the volume on request, so the Info page asks only while it's open.
export const getManagedDatabaseContainer = createServerFn({ method: "GET" })
  .validator(databaseInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedDatabase(data, "database.read")
    return relayDatabaseContainerSchema.parse(
      await databaseRpc(
        relay,
        "database.inspect",
        { databaseId: data.databaseId },
        75_000,
        user.id
      )
    )
  })

// Deletes all of the database's data and keeps the database, so it takes
// the permission that deletes it.
export const wipeManagedDatabase = createServerFn({ method: "POST" })
  .validator(databaseInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedDatabase(data, "database.delete")
    const credential = await requiredCredential(data.relayId, data.databaseId)
    const database = relayManagedDatabaseSchema.parse(
      await databaseRpc(
        relay,
        "database.wipe",
        {
          databaseId: data.databaseId,
          password: credential.password,
          username: credential.username,
        },
        120_000,
        user.id
      )
    )
    publishDatabaseChange(relay.id, false)
    return database
  })

// Renaming is managing the database as a whole, so it takes the permission
// that deletes it.
export const renameManagedDatabase = createServerFn({ method: "POST" })
  .validator(databaseRenameInputSchema)
  .handler(async ({ data }) => {
    const { relay } = await authorizedDatabase(data, "database.delete")
    await runAppEffect(
      "managedDatabases.rename",
      renameManagedDatabaseRecordEffect(relay.id, data.databaseId, data.name)
    )
    publishDatabaseChange(relay.id, true)
    return { name: data.name }
  })

export const createManagedDatabase = createServerFn({ method: "POST" })
  .validator(createDatabaseInputSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
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
    const request = {
      databaseName,
      engine: data.engine,
      id,
      name: data.name,
      password,
      username,
    }
    const register = () =>
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
    const { relayConnectionFeatures } = await import("@/lib/relay-connection")
    if (
      relayConnectionFeatures(relay.id).has(relayDatabaseProvisioningV1Feature)
    ) {
      // The Relay creates it in the background; it opens on its
      // provisioning page at once.
      const cancel = () =>
        databaseRpc(
          relay,
          "database.provision.cancel",
          { databaseId: id },
          30_000,
          user.id
        ).then((result) => cancelledSchema.parse(result).cancelled)
      const unregister = () =>
        runAppEffect(
          "managedDatabases.record.delete",
          deleteManagedDatabaseRecordEffect(relay.id, id)
        )
      // Recorded first, so a job the Relay holds always has a database in
      // Hearth to show it and delete it from.
      await register()
      const placeholder = await Effect.runPromise(
        promiseEffect(() =>
          databaseRpc(
            relay,
            "database.provision.prepare",
            { ...request, idempotencyKey: randomUUID() },
            30_000,
            user.id
          )
        ).pipe(
          Effect.map((value) => relayManagedDatabaseSchema.parse(value)),
          Effect.tapError(() => abandonPreparedProvisioning(cancel, unregister))
        )
      )
      await claimPreparedProvisioning({
        cancel,
        claim: () =>
          databaseRpc(
            relay,
            "database.provision.claim",
            { databaseId: id },
            30_000,
            user.id
          ),
        unconfirmed:
          "If it stays waiting, delete it and create it again.",
        unregister,
      })
      publishDatabaseChange(relay.id, true)
      return { ...placeholder, relayId: relay.id, relayName: relay.name }
    }
    const created = relayManagedDatabaseSchema.parse(
      await databaseRpc(relay, "database.create", request, 360_000, user.id)
    )
    const persisted = await promiseResult(register)
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

export const updateManagedDatabaseLimits = createServerFn({ method: "POST" })
  .validator(databaseLimitsInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedDatabase(
      data,
      "database.limits.write"
    )
    const { relayConnectionFeatures } = await import("@/lib/relay-connection")
    if (!relayConnectionFeatures(relay.id).has(relayDatabaseLimitsV1Feature)) {
      throw new Error("Update this Relay to set database limits")
    }
    const database = relayManagedDatabaseSchema.parse(
      await databaseRpc(
        relay,
        "database.limits.write",
        { databaseId: data.databaseId, limits: data.limits },
        240_000,
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
          member: { id: data.instanceId, kind: "instance" },
        },
        30_000,
        user.id
      )
    )
    publishDatabaseChange(relay.id, false)
    return database
  })

// Dumps travel as files in the database's dump folder on its Relay, which
// the browser downloads and uploads as it does other files: an export
// writes one there, and an import runs the one the browser uploaded.
const DUMP_TIMEOUT_MS = 60 * 60_000

export const exportManagedDatabase = createServerFn({ method: "POST" })
  .validator(databaseInputSchema)
  .handler(async ({ data }) => {
    const { relay, user, credential } = await dumpableDatabase(
      data,
      "database.dump.export"
    )
    return z
      .object({
        fileName: z.string().min(1).max(180),
        path: z.string().min(1).max(255),
        size: z.number().int().nonnegative(),
      })
      .parse(
        await databaseRpc(
          relay,
          "database.dump.export",
          {
            databaseId: data.databaseId,
            password: credential.password,
            username: credential.username,
          },
          DUMP_TIMEOUT_MS,
          user.id
        )
      )
  })

export const importManagedDatabase = createServerFn({ method: "POST" })
  .validator(
    databaseInputSchema.extend({ fileName: relayDatabaseImportFileSchema })
  )
  .handler(async ({ data }) => {
    const { relay, user, credential } = await dumpableDatabase(
      data,
      "database.dump.import"
    )
    await databaseRpc(
      relay,
      "database.dump.import",
      {
        databaseId: data.databaseId,
        fileName: data.fileName,
        password: credential.password,
        username: credential.username,
      },
      DUMP_TIMEOUT_MS,
      user.id
    )
    return { imported: true }
  })

async function dumpableDatabase(
  data: z.infer<typeof databaseInputSchema>,
  permission: "database.dump.export" | "database.dump.import"
) {
  const { relay, user } = await authorizedDatabase(data, permission)
  const { relayConnectionFeatures } = await import("@/lib/relay-connection")
  if (!relayConnectionFeatures(relay.id).has(relayDatabaseDumpFilesV1Feature)) {
    throw new Error("Update this Relay to import or export data")
  }
  const credential = await requiredCredential(data.relayId, data.databaseId)
  if (!databaseEngineSupportsLogicalBackups(credential.engine)) {
    throw new Error(
      "This database engine does not support data import or export"
    )
  }
  return { credential, relay, user }
}

export const getManagedDatabaseOverview = createServerFn({ method: "GET" })
  .validator(databaseInputSchema)
  .handler(async ({ data }) =>
    databaseOverviewSchema.parse(
      await managedDatabaseDataRequest(data, "database.data.read", {
        request: { action: "overview" },
      })
    )
  )

export const getManagedDatabaseRows = createServerFn({ method: "POST" })
  .validator(databaseRowsRequestSchema)
  .handler(async ({ data }) =>
    databaseRowsSchema.parse(
      await managedDatabaseDataRequest(data, "database.data.read", {
        request: data.request,
      })
    )
  )

// Running SQL needs write access even with `readOnly`: arbitrary SQL can
// leave a read-only transaction, so that flag only guards against mistakes.
export const runManagedDatabaseQuery = createServerFn({ method: "POST" })
  .validator(databaseQueryRequestSchema)
  .handler(async ({ data }) =>
    databaseQueryResultSchema.parse(
      await managedDatabaseDataRequest(data, "database.data.write", {
        readOnly: data.readOnly,
        request: data.request,
      })
    )
  )

export const mutateManagedDatabase = createServerFn({ method: "POST" })
  .validator(databaseMutateRequestSchema)
  .handler(async ({ data }) =>
    databaseMutateResultSchema.parse(
      await managedDatabaseDataRequest(data, "database.data.write", {
        request: data.request,
      })
    )
  )

async function managedDatabaseDataRequest(
  data: { databaseId: string; relayId: string },
  permission: "database.data.read" | "database.data.write",
  payload: { readOnly?: boolean; request: unknown }
): Promise<unknown> {
  const { relay, user } = await authorizedDatabase(data, permission)
  const credential = await requiredCredential(data.relayId, data.databaseId)
  if (!databaseEngineSupportsBrowsing(credential.engine)) {
    throw new Error("This database engine can't be browsed as tables")
  }
  return databaseRpc(
    relay,
    permission,
    {
      ...payload,
      databaseId: data.databaseId,
      password: credential.password,
      username: credential.username,
    },
    // The Relay stops database work after 25s; leave room for its reply.
    30_000,
    user.id
  )
}

// Typing and window size go to the person's own session; the Relay rejects
// a session id that isn't theirs or has ended. Output arrives through
// the terminal stream (routes/api.database-terminal.$databaseId.ts).
export const writeDatabaseTerminal = createServerFn({ method: "POST" })
  .validator(
    relayDatabaseTerminalWriteSchema.extend({ relayId: relayIdSchema })
  )
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedDatabase(data, "database.terminal")
    await databaseRpc(
      relay,
      "database.terminal.write",
      {
        data: data.data,
        databaseId: data.databaseId,
        sessionId: data.sessionId,
      },
      15_000,
      user.id
    )
    return { accepted: true }
  })

// Puts this page in control of the person's terminal session, sized to its
// window.
export const claimDatabaseTerminal = createServerFn({ method: "POST" })
  .validator(
    relayDatabaseTerminalClaimSchema.extend({ relayId: relayIdSchema })
  )
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedDatabase(data, "database.terminal")
    const claimed = await databaseRpc(
      relay,
      "database.terminal.claim",
      {
        attachmentId: data.attachmentId,
        cols: data.cols,
        databaseId: data.databaseId,
        rows: data.rows,
        sessionId: data.sessionId,
      },
      15_000,
      user.id
    )
    // The state change that put this page in control.
    return z.object({ seq: z.number().int().nonnegative() }).parse(claimed)
  })

// Ends the person's terminal session on a database. A POST server function,
// so it carries the request forgery protection a navigation would not.
export const restartDatabaseTerminal = createServerFn({ method: "POST" })
  .validator(
    relayDatabaseTerminalRestartSchema.extend({ relayId: relayIdSchema })
  )
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedDatabase(data, "database.terminal")
    await databaseRpc(
      relay,
      "database.terminal.restart",
      { databaseId: data.databaseId },
      30_000,
      user.id
    )
    return { restarted: true }
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
    const onRelay = await databaseOnRelay(relay, data.databaseId, user.id)
    if (onRelay === "missing") {
      // The Relay lists no container or job for it, as when an earlier
      // delete stopped partway, so there's nothing to back up. The Relay
      // removes what's left, keeping any data volume, which a database
      // without a container can't be backed up from.
      await deleteDatabaseWithoutFinalBackup({ ...deletion, deleteData: false })
    } else if (
      // One that never finished provisioning has no data to back up.
      onRelay === "running" &&
      databaseEngineSupportsLogicalBackups(database.engine)
    ) {
      await deleteDatabaseWithFinalBackup({ ...deletion, user })
    } else {
      await deleteDatabaseWithoutFinalBackup(deletion)
    }
    publishDatabaseChange(relay.id, true, data.databaseId)
    return { deleted: true }
  })

// What the Relay has of the database: nothing, a provisioning job, or the
// database itself.
async function databaseOnRelay(
  relay: Awaited<ReturnType<typeof requiredRelay>>,
  databaseId: string,
  userId: string
): Promise<"missing" | "provisioning" | "running"> {
  // Only this database. Its detail tells a failed provisioning job from a
  // database that exists but failed, which share an observed state.
  const [item] = z
    .array(
      z
        .object({ database: relayManagedDatabaseSchema.optional() })
        .loose()
    )
    .parse(
      await databaseRpc(
        relay,
        "database.list",
        { requests: [{ id: databaseId, view: "detail" }] },
        30_000,
        userId
      )
    )
  if (!item) return "missing"
  return item.database?.provisioning ? "provisioning" : "running"
}

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
      grantHasPermission(grant, permission) &&
      (grant.resourceType === "relay" ||
        (grant.resourceType === "database" &&
          databaseId !== undefined &&
          grant.resourceId === databaseId))
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
