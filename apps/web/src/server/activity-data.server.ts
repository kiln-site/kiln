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

  // A game server copied with its history includes what happened to the
  // server it came from until the copy finished. Whoever can see that server
  // sees those events as its, marked as the copy's history too; whoever can
  // see only the copy sees them as the copy's own. What happens to the old
  // server afterwards stays its own.
  const inherited = inheritedActivity(
    await listActivityLineage(),
    (relayId, instanceId) => {
      const scope = scopes.get(relayId)
      return Boolean(
        scope && (scope.allInstances || scope.instanceIds.has(instanceId))
      )
    }
  )

  const visibleRelays = relays.filter((relay) => scopes.has(relay.id))
  const baseQuery = {
    ...(data.from ? { from: Date.parse(data.from) } : {}),
    limit: Math.min(Math.max(data.limit ?? 2_000, 1), 2_000),
    ...(data.to ? { to: Date.parse(data.to) } : {}),
  }
  const { relayRpc } = await import("@/lib/relay-connection")
  const listAudits = (
    relay: PersistedRelay,
    query: object,
    signal?: AbortSignal
  ) =>
    relayRpc(relay, "relay.audit.list", query, 10_000, undefined, signal).then(
      (value) => z.array(relayAuditRecordSchema).parse(value)
    )
  const relayById = new Map(relays.map((relay) => [relay.id, relay]))
  // A server someone can't see has its history, as its copies', asked for
  // apart: one query per server and cutoff, so each copy's history is asked
  // for up to its own cutoff and later activity can't crowd it out. A
  // Relay's are asked one at a time, beside its other requests. A server
  // they can see needs none, its events being in its Relay's answer.
  const inheritedQueries = new Map<
    string,
    Map<
      string,
      {
        copies: Array<InheritedActivity["copies"][number]>
        instanceId: string
        until: number
      }
    >
  >()
  for (const source of inherited.values()) {
    if (source.visible || !relayById.has(source.relayId)) continue
    const queries = inheritedQueries.get(source.relayId) ?? new Map()
    for (const copy of source.copies) {
      const key = `${source.instanceId}:${copy.until}`
      const query = queries.get(key)
      if (query) query.copies.push(copy)
      else {
        queries.set(key, {
          copies: [copy],
          instanceId: source.instanceId,
          until: copy.until,
        })
      }
    }
    inheritedQueries.set(source.relayId, queries)
  }
  const [results, inheritedResults] = await Promise.all([
    Promise.all(
      visibleRelays.map(async (relay) => {
        const scope = scopes.get(relay.id)
        const query =
          scope?.allInstances === false
            ? { ...baseQuery, instanceIds: [...scope.instanceIds] }
            : baseQuery
        const [auditResult, snapshotResult] = await Promise.allSettled([
          listAudits(relay, query),
          relayRpc(relay, "relay.snapshot", {}, 5_000).then((value) =>
            relaySnapshotSchema.parse(value)
          ),
        ])
        return { auditResult, relay, snapshotResult }
      })
    ),
    Promise.all(
      [...inheritedQueries].map(async ([relayId, queries]) => {
        const relay = relayById.get(relayId)
        const answered: Array<{
          copies: Array<InheritedActivity["copies"][number]>
          instanceId: string
          records: Array<RelayAuditRecord> | null
          relay: PersistedRelay
        }> = []
        if (!relay) return answered
        // Within one request's time in all, connecting included: once a
        // Relay fails or the time is up, the rest count as unavailable
        // rather than holding up the whole answer.
        const budget = AbortSignal.timeout(10_000)
        let reachable = true
        for (const query of queries.values()) {
          const [records] =
            reachable && !budget.aborted
              ? await Promise.allSettled([
                  listAudits(
                    relay,
                    {
                      ...baseQuery,
                      instanceIds: [query.instanceId],
                      to: Math.min(baseQuery.to ?? query.until, query.until),
                    },
                    budget
                  ),
                ])
              : [null]
          if (records?.status !== "fulfilled") reachable = false
          answered.push({
            copies: query.copies,
            instanceId: query.instanceId,
            records: records?.status === "fulfilled" ? records.value : null,
            relay,
          })
        }
        return answered
      })
    ).then((answers) => answers.flat()),
  ])
  const available = results.flatMap((result) =>
    result.auditResult.status === "fulfilled"
      ? [{ records: result.auditResult.value, relay: result.relay }]
      : []
  )
  // A copy whose inherited history couldn't be read shows its Relay as
  // unavailable, as its own activity would.
  const unavailableRelayIds = new Set([
    ...results.flatMap((result) =>
      result.auditResult.status === "rejected" ? [result.relay.id] : []
    ),
    ...inheritedResults.flatMap((result) =>
      result.records === null
        ? result.copies.map((copy) => copy.copy.relayId)
        : []
    ),
  ])
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
  const visibleAudits: Array<VisibleAudit> = available.flatMap(
    ({ records, relay }) => {
      const scope = scopes.get(relay.id)
      return scope
        ? records.flatMap((record): Array<VisibleAudit> =>
            scopeAllowsAudit(scope, record)
              ? [{ copy: null, heirs: [], record, relay }]
              : []
          )
        : []
    }
  )
  // An event of a server someone can see is shown once, as its, with each
  // copy it's history of.
  const audits = new Map<string, Array<VisibleAudit>>()
  for (const audit of visibleAudits) {
    const instanceId = auditInstanceId(audit.record)
    if (!instanceId) continue
    const key = instanceKey(audit.relay.id, instanceId)
    const known = audits.get(key)
    if (known) known.push(audit)
    else audits.set(key, [audit])
  }
  for (const source of inherited.values()) {
    if (!source.visible) continue
    for (const audit of audits.get(
      instanceKey(source.relayId, source.instanceId)
    ) ?? []) {
      for (const copy of source.copies) {
        if (audit.record.occurredAt <= copy.until) audit.heirs.push(copy.copy)
      }
    }
  }
  // One of a server they can't see is shown once for each copy, as its.
  for (const { copies, instanceId, records, relay } of inheritedResults) {
    for (const record of records ?? []) {
      if (auditInstanceId(record) !== instanceId) continue
      for (const copy of copies) {
        if (record.occurredAt <= copy.until) {
          visibleAudits.push({ copy: copy.copy, heirs: [], record, relay })
        }
      }
    }
  }

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

  const entries = visibleAudits
    .map(({ copy, heirs, record, relay: recordedRelay }) => {
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
        id: copy
          ? `${recordedRelay.id}:${record.id}:${copy.relayId}:${copy.instanceId}`
          : `${recordedRelay.id}:${record.id}`,
        // The copies this event is history of, besides its own server.
        inheritedBy: heirs,
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

  return {
    entries,
    relays: visibleRelays.map((relay) => ({
      id: relay.id,
      name: relay.name,
      unavailable: unavailableRelayIds.has(relay.id),
    })),
    truncatedRelayIds: available.flatMap(({ records, relay }) =>
      records.length === 2_000 ? [relay.id] : []
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
  readonly copy: InheritedActivity["copies"][number]["copy"] | null
  /** Copies whose history an event shown as its own server's is. */
  readonly heirs: Array<InheritedActivity["copies"][number]["copy"]>
  readonly record: RelayAuditRecord
  readonly relay: PersistedRelay
}

interface InheritedActivity {
  readonly instanceId: string
  readonly relayId: string
  /** Whether the person can see this server itself. */
  readonly visible: boolean
  /** The copies its events show as, each up to when it was made. */
  readonly copies: ReadonlyArray<{
    readonly copy: { readonly instanceId: string; readonly relayId: string }
    readonly until: number
  }>
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
// keyed by server, with each such copy: up to when it finished, or the
// earliest such time along a copy of a copy. Whether they can see the
// server itself decides whose events they're shown as.
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
      inherited.set(sourceKey, {
        copies: [...(known?.copies ?? []), { copy, until }],
        instanceId: source.instanceId,
        relayId: source.relayId,
        visible: canSee(source.relayId, source.instanceId),
      })
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
