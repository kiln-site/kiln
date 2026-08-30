import {
  relayAuditRecordSchema,
  relayIdSchema,
  relaySnapshotSchema,
} from "@workspace/contracts"
import type { RelayObservedState } from "@workspace/contracts"
import type { RowDataPacket } from "mysql2/promise"
import { z } from "zod"

import {
  activityLabelForAudit,
  activityPermissionForAudit,
  activitySourceForAudit,
  activityTypeForAudit,
  auditInstanceId,
  auditUserId,
  scopeAllowsAudit,
} from "@/lib/activity"
import type { ActivityScope } from "@/lib/activity"
import { isPlatformAdmin, listUserGrants } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import { roleHasPermission } from "@/lib/permissions"
import { listPersistedRelays } from "@/lib/relay-registry"

interface InstanceRow extends RowDataPacket {
  display_name: string | null
  instance_id: string
  relay_id: string
}

interface ActivityInstance {
  brickId?: string
  brickSource?: string
  displayName: string | null
  implementation?: string
  instanceId: string
  observedState?: RelayObservedState
  relayId: string
}

interface UserRow extends RowDataPacket {
  email: string
  id: string
  name: string
}

const systemActorId = "system"

export async function getActivityForUser(
  user: AuthenticatedUser,
  data: { from?: string; limit?: number; to?: string }
) {
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  const platformAdmin = isPlatformAdmin(user)
  const grants = platformAdmin ? [] : await listUserGrants(user.id)
  const scopes = new Map<string, ActivityScope>()

  for (const relay of relays) {
    if (platformAdmin) {
      scopes.set(relay.id, {
        allInstances: true,
        instanceIds: new Set(),
      })
      continue
    }
    const relayGrants = grants.filter(
      (grant) =>
        grant.relayId === relay.id &&
        roleHasPermission(grant.role, "instance.read")
    )
    const allInstances = relayGrants.some(
      (grant) => grant.resourceType === "relay"
    )
    const instanceIds = new Set(
      relayGrants.flatMap((grant) =>
        grant.resourceType === "instance" ? [grant.resourceId] : []
      )
    )
    if (allInstances || instanceIds.size > 0) {
      scopes.set(relay.id, { allInstances, instanceIds })
    }
  }

  const visibleRelays = relays.filter((relay) => scopes.has(relay.id))
  const baseQuery = {
    ...(data.from ? { from: Date.parse(data.from) } : {}),
    limit: Math.min(Math.max(data.limit ?? 2_000, 1), 2_000),
    ...(data.to ? { to: Date.parse(data.to) } : {}),
  }
  const results = await Promise.all(
    visibleRelays.map(async (relay) => {
      const { relayRpc } = await import("@/lib/relay-connection")
      const scope = scopes.get(relay.id)
      const query =
        scope?.allInstances === false
          ? { ...baseQuery, instanceIds: [...scope.instanceIds] }
          : baseQuery
      const [auditResult, snapshotResult] = await Promise.allSettled([
        relayRpc(relay, "relay.audit.list", query, 10_000).then((value) =>
          z.array(relayAuditRecordSchema).parse(value)
        ),
        relayRpc(relay, "relay.snapshot", {}, 5_000).then((value) =>
          relaySnapshotSchema.parse(value)
        ),
      ])
      return { auditResult, relay, snapshotResult }
    })
  )
  const available = results.flatMap((result) =>
    result.auditResult.status === "fulfilled"
      ? [{ records: result.auditResult.value, relay: result.relay }]
      : []
  )
  const unavailableRelayIds = new Set(
    results.flatMap((result) =>
      result.auditResult.status === "rejected" ? [result.relay.id] : []
    )
  )
  const snapshotInstances: Array<ActivityInstance> = results.flatMap(
    ({ relay, snapshotResult }) =>
      snapshotResult.status === "fulfilled"
        ? snapshotResult.value.instances.map((instance) => ({
            brickId: instance.brickId,
            brickSource: instance.brickSource,
            displayName: instance.name,
            implementation: instance.implementation,
            instanceId: instance.id,
            observedState: instance.observedState,
            relayId: relay.id,
          }))
        : []
  )
  const visibleAudits = available.flatMap(({ records, relay }) => {
    const scope = scopes.get(relay.id)
    if (!scope) return []
    return records.flatMap((record) =>
      scopeAllowsAudit(scope, record) ? [{ record, relay }] : []
    )
  })

  const [instanceRows, userRows] = await Promise.all([
    listActivityInstances(visibleRelays.map((relay) => relay.id)),
    listActivityUsers(
      visibleAudits.flatMap(({ record }) => {
        const userId = auditUserId(record)
        return userId ? [userId] : []
      })
    ),
  ])
  const instanceByKey = new Map<string, ActivityInstance>(
    instanceRows.map((instance) => [
      instanceKey(instance.relay_id, instance.instance_id),
      {
        displayName: instance.display_name,
        instanceId: instance.instance_id,
        relayId: instance.relay_id,
      },
    ])
  )
  for (const instance of snapshotInstances) {
    instanceByKey.set(
      instanceKey(instance.relayId, instance.instanceId),
      instance
    )
  }
  const userById = new Map(userRows.map((actor) => [actor.id, actor]))

  const entries = visibleAudits
    .map(({ record, relay }) => {
      const instanceId = auditInstanceId(record)
      const instance = instanceId
        ? instanceByKey.get(instanceKey(relay.id, instanceId))
        : undefined
      const actorId = auditUserId(record)
      const actor = actorId ? userById.get(actorId) : undefined
      return {
        actor: actorId
          ? {
              email: actor?.email ?? null,
              id: actorId,
              name: actor?.name ?? "Former user",
            }
          : {
              email: null,
              id: systemActorId,
              name: "Kiln system",
            },
        id: `${relay.id}:${record.id}`,
        label: activityLabelForAudit(record),
        occurredAt: record.occurredAt,
        permission: activityPermissionForAudit(record),
        rawEvent: record.event,
        relay: {
          id: relay.id,
          name: relay.name,
          unavailable: unavailableRelayIds.has(relay.id),
        },
        server: instanceId
          ? {
              brickId: instance?.brickId,
              brickSource: instance?.brickSource,
              id: instanceId,
              implementation: instance?.implementation,
              name: instance?.displayName ?? `Server ${instanceId.slice(0, 8)}`,
              observedState: instance?.observedState,
            }
          : null,
        source: activitySourceForAudit(record),
        type: activityTypeForAudit(record),
      }
    })
    .sort((left, right) => right.occurredAt - left.occurredAt)

  return {
    entries,
    relays: visibleRelays.map((relay) => ({
      id: relay.id,
      name: relay.name,
      unavailable: unavailableRelayIds.has(relay.id),
    })),
    servers: [...instanceByKey.values()]
      .flatMap((instance) => {
        const scope = scopes.get(instance.relayId)
        const visible =
          scope?.allInstances === true ||
          scope?.instanceIds.has(instance.instanceId) === true
        return visible
          ? [
              {
                brickId: instance.brickId,
                brickSource: instance.brickSource,
                id: instance.instanceId,
                implementation: instance.implementation,
                name:
                  instance.displayName ??
                  `Server ${instance.instanceId.slice(0, 8)}`,
                observedState: instance.observedState,
                relayId: instance.relayId,
              },
            ]
          : []
      })
      .sort((left, right) => left.name.localeCompare(right.name)),
    truncatedRelayIds: available.flatMap(({ records, relay }) =>
      records.length === 2_000 ? [relay.id] : []
    ),
  }
}

async function listActivityInstances(
  relayIds: Array<z.infer<typeof relayIdSchema>>
): Promise<Array<InstanceRow>> {
  if (relayIds.length === 0) return []
  const [rows] = await databasePool.query<Array<InstanceRow>>(
    `SELECT relay_id, instance_id, display_name
       FROM ${databaseTable("instance")}
      WHERE relay_id IN (?)
      ORDER BY display_name ASC, instance_id ASC`,
    [relayIds]
  )
  return rows
}

async function listActivityUsers(
  userIds: Array<string>
): Promise<Array<UserRow>> {
  const uniqueIds = [...new Set(userIds)]
  if (uniqueIds.length === 0) return []
  const [rows] = await databasePool.query<Array<UserRow>>(
    `SELECT id, name, email
       FROM ${databaseTable("user")}
      WHERE id IN (?)`,
    [uniqueIds]
  )
  return rows
}

function instanceKey(relayId: string, instanceId: string): string {
  return `${relayId}:${instanceId}`
}
