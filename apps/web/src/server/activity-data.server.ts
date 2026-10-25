import {
  appIdFromFileRoot,
  appTailscaleMember,
  isRelayFileRoot,
  relayAuditRecordSchema,
  relayIdSchema,
  relaySnapshotSchema,
} from "@workspace/contracts"
import type { RelayAuditRecord } from "@workspace/contracts"
import type { RowDataPacket } from "mysql2/promise"
import { z } from "zod"

import {
  activityLabelForAudit,
  activityPermissionForAudit,
  activitySourceForAudit,
  activityTypeForAudit,
  auditAppId,
  auditDatabaseId,
  auditInstanceId,
  auditUserId,
  scopeAllowsAudit,
} from "@/lib/activity"
import type { ActivityScope } from "@/lib/activity"
import { isPlatformAdmin, listUserGrants } from "@/lib/access-control"
import { requireEligibleAccount } from "@/lib/account-policy"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import { grantHasPermission } from "@/lib/permissions"
import { listPersistedRelays, type PersistedRelay } from "@/lib/relay-registry"

interface InstanceRow extends RowDataPacket {
  display_name: string | null
  instance_id: string
  relay_id: string
}

interface ActivityInstance {
  displayName: string | null
  instanceId: string
  relayId: string
}

interface ResourceNameRow extends RowDataPacket {
  id: string
  name: string
  relay_id: string
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
  requireEligibleAccount(user)
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  const platformAdmin = isPlatformAdmin(user)
  const grants = platformAdmin ? [] : await listUserGrants(user.id)
  const scopes = new Map<string, ActivityScope & { instanceIds: Set<string> }>()

  for (const relay of relays) {
    if (platformAdmin) {
      scopes.set(relay.id, {
        relayAudit: true,
        allInstances: true,
        instanceIds: new Set(),
      })
      continue
    }
    const relayAudit = grants.some(
      (grant) =>
        grant.relayId === relay.id &&
        grant.resourceType === "relay" &&
        grantHasPermission(grant, "relay.audit.read")
    )
    const relayGrants = grants.filter(
      (grant) =>
        grant.relayId === relay.id && grantHasPermission(grant, "instance.read")
    )
    const allInstances =
      relayAudit || relayGrants.some((grant) => grant.resourceType === "relay")
    const instanceIds = new Set(
      relayGrants.flatMap((grant) =>
        grant.resourceType === "instance" ? [grant.resourceId] : []
      )
    )
    if (allInstances || instanceIds.size > 0) {
      scopes.set(relay.id, { relayAudit, allInstances, instanceIds })
    }
  }

  // A game server copied with its history shows what happened to the server
  // it came from until the copy finished, as its own, to whoever can see the
  // copy but not that server. What happens to it afterwards stays its own.
  const inherited = platformAdmin
    ? new Map<string, InheritedActivity>()
    : inheritedActivity(await listActivityLineage(), (relayId, instanceId) => {
        const scope = scopes.get(relayId)
        return Boolean(
          scope && (scope.allInstances || scope.instanceIds.has(instanceId))
        )
      })
  const enabledRelayIds = new Set(relays.map((relay) => relay.id))
  const queryScopes = new Map(
    [...scopes].map(([relayId, scope]) => [
      relayId,
      { ...scope, instanceIds: new Set(scope.instanceIds) },
    ])
  )
  for (const source of inherited.values()) {
    if (!enabledRelayIds.has(source.relayId)) continue
    const scope = queryScopes.get(source.relayId)
    if (scope) scope.instanceIds.add(source.instanceId)
    else {
      queryScopes.set(source.relayId, {
        allInstances: false,
        instanceIds: new Set([source.instanceId]),
        relayAudit: false,
      })
    }
  }

  const visibleRelays = relays.filter((relay) => queryScopes.has(relay.id))
  const baseQuery = {
    ...(data.from ? { from: Date.parse(data.from) } : {}),
    limit: Math.min(Math.max(data.limit ?? 2_000, 1), 2_000),
    ...(data.to ? { to: Date.parse(data.to) } : {}),
  }
  const { relayRpc } = await import("@/lib/relay-connection")
  const results = await Promise.all(
    visibleRelays.map(async (relay) => {
      const scope = queryScopes.get(relay.id)
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
            displayName: instance.name,
            instanceId: instance.id,
            relayId: relay.id,
          }))
        : []
  )
  const visibleAudits = available.flatMap(({ records, relay }) => {
    const scope = scopes.get(relay.id)
    return records.flatMap((record): Array<VisibleAudit> => {
      if (scope && scopeAllowsAudit(scope, record)) {
        return [{ copy: null, record, relay }]
      }
      const instanceId = auditInstanceId(record)
      const source = instanceId
        ? inherited.get(instanceKey(relay.id, instanceId))
        : undefined
      return source && record.occurredAt <= source.until
        ? [{ copy: source.copy, record, relay }]
        : []
    })
  })

  const visibleRelayIds = visibleRelays.map((relay) => relay.id)
  const [instanceRows, userRows, appRows, databaseRows] = await Promise.all([
    listActivityInstances(visibleRelayIds),
    listActivityUsers(
      visibleAudits.flatMap(({ record }) => {
        const userId = auditUserId(record)
        return userId ? [userId] : []
      })
    ),
    listActivityResourceNames("app", visibleRelayIds),
    listActivityResourceNames("database", visibleRelayIds),
  ])
  const appNames = resourceNames(appRows)
  const databaseNames = resourceNames(databaseRows)
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

  // What an event acted on. Apps and Relays can take a game server's place:
  // an app runs as a Relay instance, its files are `app:<id>`, and its
  // Tailscale members `app:<id>:<service>`; a Relay's host files use its
  // fingerprint. A game server wins over a database it was linked to.
  const activityTarget = (relayId: string, record: RelayAuditRecord) => {
    const recordedId = auditInstanceId(record)
    const instanceAppId = recordedId
      ? (appIdFromFileRoot(recordedId) ??
        appTailscaleMember(recordedId)?.appId ??
        (appNames.has(instanceKey(relayId, recordedId)) ? recordedId : null))
      : null
    const instanceId =
      recordedId && !instanceAppId && !isRelayFileRoot(recordedId)
        ? recordedId
        : null
    const appId = auditAppId(record) ?? instanceAppId
    if (appId) {
      return {
        id: appId,
        kind: "app" as const,
        name:
          appNames.get(instanceKey(relayId, appId)) ??
          `App ${appId.slice(0, 8)}`,
      }
    }
    if (instanceId) {
      return {
        id: instanceId,
        kind: "server" as const,
        name:
          instanceByKey.get(instanceKey(relayId, instanceId))?.displayName ??
          `Server ${instanceId.slice(0, 8)}`,
      }
    }
    const databaseId = auditDatabaseId(record)
    if (databaseId) {
      return {
        id: databaseId,
        kind: "database" as const,
        name:
          databaseNames.get(instanceKey(relayId, databaseId)) ??
          `Database ${databaseId.slice(0, 8)}`,
      }
    }
    return null
  }

  const relayById = new Map(relays.map((relay) => [relay.id, relay]))
  const entries = visibleAudits
    .map(({ copy, record, relay: recordedRelay }) => {
      // An event of the server a copy came from, shown as the copy's.
      const relay = copy
        ? (relayById.get(copy.relayId) ?? recordedRelay)
        : recordedRelay
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
        // Kept beside the target: connecting a database to a game server
        // targets the server but belongs in the database's activity too.
        databaseId: auditDatabaseId(record),
        id: `${recordedRelay.id}:${record.id}`,
        label: activityLabelForAudit(record),
        occurredAt: record.occurredAt,
        permission: activityPermissionForAudit(record),
        rawEvent: record.event,
        relay: {
          id: relay.id,
          name: relay.name,
          unavailable: unavailableRelayIds.has(relay.id),
        },
        source: activitySourceForAudit(record),
        target: copy
          ? {
              id: copy.instanceId,
              kind: "server" as const,
              name:
                instanceByKey.get(instanceKey(copy.relayId, copy.instanceId))
                  ?.displayName ?? `Server ${copy.instanceId.slice(0, 8)}`,
            }
          : activityTarget(relay.id, record),
        type: activityTypeForAudit(record),
      }
    })
    .sort((left, right) => right.occurredAt - left.occurredAt)

  // Relays read only for a copy's history stay out of the person's list.
  return {
    entries,
    relays: visibleRelays.flatMap((relay) =>
      scopes.has(relay.id)
        ? [
            {
              id: relay.id,
              name: relay.name,
              unavailable: unavailableRelayIds.has(relay.id),
            },
          ]
        : []
    ),
    truncatedRelayIds: available.flatMap(({ records, relay }) =>
      records.length === 2_000 && scopes.has(relay.id) ? [relay.id] : []
    ),
  }
}

interface LineageRow extends RowDataPacket {
  destination_instance_id: string
  destination_relay_id: string
  finished_at: number | string
  source_instance_id: string
  source_relay_id: string
}

interface VisibleAudit {
  /** Set for an event shown as a copy's, from the server it came from. */
  readonly copy: InheritedActivity["copy"] | null
  readonly record: RelayAuditRecord
  readonly relay: PersistedRelay
}

interface InheritedActivity {
  /** The copy its events show as. */
  readonly copy: { readonly instanceId: string; readonly relayId: string }
  readonly instanceId: string
  readonly relayId: string
  /** Its events up to here are the copy's history too. */
  readonly until: number
}

// Servers copied with their history, from the server each came from.
async function listActivityLineage(): Promise<Array<LineageRow>> {
  const [rows] = await databasePool.query<Array<LineageRow>>(
    `SELECT source_relay_id, source_instance_id,
            destination_relay_id, destination_instance_id, finished_at
       FROM ${databaseTable("server_migration")}
      WHERE state = 'completed' AND finished_at IS NOT NULL
        AND options->>'$.keepActivity' = 'true'`
  )
  return rows
}

// The servers whose history someone sees through copies they can see,
// keyed by server: each up to when its copy finished, or the earliest
// such time along a copy of a copy.
function inheritedActivity(
  lineage: ReadonlyArray<LineageRow>,
  canSee: (relayId: string, instanceId: string) => boolean
): Map<string, InheritedActivity> {
  const sources = new Map(
    lineage.map((row) => [
      instanceKey(row.destination_relay_id, row.destination_instance_id),
      {
        instanceId: row.source_instance_id,
        relayId: row.source_relay_id,
        until: Number(row.finished_at),
      },
    ])
  )
  const inherited = new Map<string, InheritedActivity>()
  for (const row of lineage) {
    const copy = {
      instanceId: row.destination_instance_id,
      relayId: row.destination_relay_id,
    }
    if (!canSee(copy.relayId, copy.instanceId)) continue
    let current = copy
    let until = Number.POSITIVE_INFINITY
    const seen = new Set<string>()
    while (true) {
      const key = instanceKey(current.relayId, current.instanceId)
      const source = sources.get(key)
      if (!source || seen.has(key)) break
      seen.add(key)
      until = Math.min(until, source.until)
      const sourceKey = instanceKey(source.relayId, source.instanceId)
      const known = inherited.get(sourceKey)
      if (
        !canSee(source.relayId, source.instanceId) &&
        (!known || known.until < until)
      ) {
        inherited.set(sourceKey, { ...source, copy, until })
      }
      current = source
    }
  }
  return inherited
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

async function listActivityResourceNames(
  table: "app" | "database",
  relayIds: Array<z.infer<typeof relayIdSchema>>
): Promise<Array<ResourceNameRow>> {
  if (relayIds.length === 0) return []
  const [rows] = await databasePool.query<Array<ResourceNameRow>>(
    `SELECT relay_id, ${table}_id AS id, name
       FROM ${databaseTable(table)}
      WHERE relay_id IN (?)`,
    [relayIds]
  )
  return rows
}

function resourceNames(rows: Array<ResourceNameRow>): Map<string, string> {
  return new Map(
    rows.map((row) => [instanceKey(row.relay_id, row.id), row.name])
  )
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
