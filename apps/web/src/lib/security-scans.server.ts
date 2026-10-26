import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"

import {
  relayControlDeadlineMs,
  relaySecurityInventoryMaxBytes,
  relaySecurityInventoryResponseSchema,
  relaySecurityInventoryV1Feature,
  relaySecurityTargetsSchema,
  type AccessPermission,
  type RelaySecurityInventoryResponse,
  type RelaySecurityTarget,
} from "@workspace/contracts"
import { logException } from "@workspace/telemetry"
import { Cause, Clock, Effect, Fiber, Queue } from "effect"

import { ExternalServiceError } from "@/effect/errors"
import { Grype } from "@/effect/grype"
import { loadNotificationPreferencesEffect } from "@/effect/notification-preferences"
import { Database } from "@/effect/database"
import {
  publishNotificationChange,
  replaceNotificationEffect,
} from "@/effect/notifications"
import { forkAppWorker } from "@/effect/runtime"
import {
  dueInventoriesEffect,
  hasInventoriesEffect,
  HOST_INVENTORY_MAX_AGE_MS,
  loadInventoryDocumentEffect,
  pendingMatchesEffect,
  recordFindingsEffect,
  recordInventoryEffect,
  recordInventoryFailureEffect,
  recordMatchFailureEffect,
  securityResourceNamesEffect,
  syncSecurityTargetsEffect,
  pendingSecurityAnnouncementsEffect,
  recordSecurityAnnouncementsEffect,
  type AnnouncedFinding,
  type DueInventory,
  type SecurityAnnouncement,
} from "@/effect/security"
import { databaseTable } from "@/lib/database-config"
import type {
  NotificationContent,
  NotificationResource,
} from "@/lib/notifications"
import { relayConnectionFeatures, relayRpc } from "@/lib/relay-connection"
import {
  listPersistedRelaysEffect,
  type PersistedRelay,
} from "@/lib/relay-registry"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { resourceAudienceEffect } from "@/lib/resource-audience.server"
import {
  defaultSecurityNotificationSettings,
  severityAt,
  severityRank,
  type SecurityNotificationSettings,
} from "@/lib/security"

// Keeps what each Relay runs checked against known vulnerabilities.
//
// Every 15 minutes Hearth asks each Relay what it runs, which costs it one
// container listing, and asks for an inventory of each image it hasn't seen,
// and of the host once a day. Inventories stay in Hearth's database, so a
// Relay that's unreachable is still covered by what it last reported.
//
// Grype checks each new inventory, and every inventory again whenever its
// vulnerability database changes, which Hearth looks for every six hours.
// Findings nobody has heard of go to the people who can act on them.

const sweepInterval = "2 minutes"
const syncIntervalMs = 15 * 60_000
// After the host was busy, how soon to ask again.
const busyRetryMs = 5 * 60_000
const databaseCheckIntervalMs = 6 * 60 * 60_000
// How long one sweep spends collecting from one Relay, and checking
// inventories, before it moves on. What's left continues in the next sweep,
// which comes at once, so a slow Relay or a new vulnerability database can't
// hold up the others.
const collectBudgetMs = 60_000
const matchBudgetMs = 120_000
const inventoryChunkTimeoutMs = 60_000
// Hearth stores inventories in a MEDIUMBLOB.
const storedInventoryMaxBytes = 16 * 1024 * 1024 - 1

declare global {
  var kilnSecurityScanner: Fiber.Fiber<void> | undefined
  var kilnSecuritySynced: Map<string, number> | undefined
  var kilnSecurityDatabase:
    | { builtAt: number | null; checkedAt: number; failure: string | null }
    | undefined
  var kilnSecurityWake: Queue.Queue<void> | undefined
}

// When each Relay last reported what it runs. A restart asks again.
const synced = (globalThis.kilnSecuritySynced ??= new Map<string, number>())
// A sweep someone asked for, by scanning now; one pending is enough.
const wake = (globalThis.kilnSecurityWake ??= Effect.runSync(
  Queue.dropping<void>(1)
))

/** What people who can act on a resource's vulnerabilities hold. */
export const securityNotifyPermissions = {
  app: "app.manage",
  database: "database.power",
  instance: "instance.configuration.write",
  relay: "relay.update",
} as const satisfies Record<
  SecurityAnnouncement["resourceType"],
  AccessPermission
>

function inventories(relay: PersistedRelay): boolean {
  return (
    relay.enabled &&
    relayConnectionFeatures(relay.id).has(relaySecurityInventoryV1Feature)
  )
}

/** Has the worker look at this Relay at once, as after Scan now. */
export function scanRelaySoon(relayId: string): void {
  synced.delete(relayId)
  Queue.offerUnsafe(wake, undefined)
}

const relayFailure = (message: string) => (cause: unknown) =>
  ExternalServiceError.make({ cause, message, service: "Relay" })

const syncRelayEffect = Effect.fnUntraced(function* (relay: PersistedRelay) {
  const report = yield* Effect.tryPromise({
    try: (signal) =>
      relayRpc(relay, "relay.security.targets", {}, 30_000, undefined, signal),
    catch: relayFailure("Could not list what the Relay runs"),
  }).pipe(Effect.map((answer) => relaySecurityTargetsSchema.parse(answer)))
  yield* syncSecurityTargetsEffect(relay.id, report)
  const due = yield* dueInventoriesEffect(relay.id)
  const deadline = (yield* Clock.currentTimeMillis) + collectBudgetMs
  let busy = false
  let more = false
  for (const inventory of due) {
    if ((yield* Clock.currentTimeMillis) >= deadline) {
      more = true
      break
    }
    if (report.scanner === null) {
      yield* recordInventoryFailureEffect(
        relay.id,
        inventory.sbomKey,
        "Update this Relay to inventory its software"
      )
      continue
    }
    // One that fails waits for its retry rather than holding up the rest.
    const outcome = yield* collectInventoryEffect(relay, inventory).pipe(
      Effect.catch((error) =>
        recordInventoryFailureEffect(
          relay.id,
          inventory.sbomKey,
          error.message
        ).pipe(Effect.as("failed" as const))
      )
    )
    if (outcome === "busy") {
      busy = true
      break
    }
  }
  return { busy, more }
})

// Reads one inventory from the Relay, in chunks, and keeps it.
const collectInventoryEffect = Effect.fn("Security.collectInventory")(
  function* (relay: PersistedRelay, inventory: DueInventory) {
    yield* Effect.annotateCurrentSpan({
      "relay.id": relay.id,
      "security.inventory": inventory.sbomKey,
    })
    const target: RelaySecurityTarget =
      inventory.sbomKey === "host"
        ? { kind: "host" }
        : {
            image: inventory.image ?? "",
            imageId: inventory.sbomKey,
            kind: "image",
          }
    const now = yield* Clock.currentTimeMillis
    // An image's inventory never changes; the host's is wanted newer than
    // the one Hearth has, or than a day old.
    const collectedAfter =
      target.kind === "image"
        ? null
        : (inventory.collectedAt ??
          (inventory.requested
            ? now - 60_000
            : now - HOST_INVENTORY_MAX_AGE_MS))
    const read = (offset: number, after: number | null) =>
      Effect.tryPromise({
        try: (signal) =>
          relayRpc(
            relay,
            "relay.security.inventory",
            { collectedAfter: after, offset, target },
            offset === 0
              ? relayControlDeadlineMs("relay.security.inventory")
              : inventoryChunkTimeoutMs,
            undefined,
            signal
          ),
        catch: relayFailure("Could not read the Relay's inventory"),
      }).pipe(
        Effect.map((answer) =>
          relaySecurityInventoryResponseSchema.parse(answer)
        )
      )
    const first = yield* read(0, collectedAfter)
    if (first.status === "busy") return "busy" as const
    if (first.status === "failed") {
      yield* recordInventoryFailureEffect(
        relay.id,
        inventory.sbomKey,
        first.error
      )
      return "failed" as const
    }
    const chunks = [Buffer.from(first.data, "base64")]
    let received = chunks[0]!.length
    while (received < first.size) {
      const next: RelaySecurityInventoryResponse = yield* read(
        received,
        first.collectedAt - 1
      )
      if (
        next.status !== "ready" ||
        next.sha256 !== first.sha256 ||
        next.offset !== received
      ) {
        yield* recordInventoryFailureEffect(
          relay.id,
          inventory.sbomKey,
          "The inventory changed while Hearth read it"
        )
        return "failed" as const
      }
      const chunk = Buffer.from(next.data, "base64")
      if (chunk.length === 0) break
      chunks.push(chunk)
      received += chunk.length
    }
    const gzipped = Buffer.concat(chunks)
    if (
      gzipped.length !== first.size ||
      createHash("sha256").update(gzipped).digest("hex") !== first.sha256
    ) {
      yield* recordInventoryFailureEffect(
        relay.id,
        inventory.sbomKey,
        "The inventory arrived damaged"
      )
      return "failed" as const
    }
    const prepared = yield* Effect.try({
      try: () => readInventory(gzipped),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }).pipe(Effect.result)
    if (prepared._tag === "Failure") {
      yield* recordInventoryFailureEffect(
        relay.id,
        inventory.sbomKey,
        prepared.failure.message
      )
      return "failed" as const
    }
    yield* recordInventoryEffect(relay.id, inventory.sbomKey, {
      ...prepared.success,
      collectedAt: first.collectedAt,
      generator: first.generator,
    })
    return "collected" as const
  }
)

/**
 * A Relay's gzipped Syft JSON, checked. It's read whole only within the size
 * the Relay may send, so no Relay can run Hearth out of memory.
 */
function readInventory(gzipped: Buffer) {
  if (gzipped.length > storedInventoryMaxBytes) {
    throw new Error("The inventory is too large to keep")
  }
  const raw = gunzipSync(gzipped, {
    maxOutputLength: relaySecurityInventoryMaxBytes,
  })
  const document = JSON.parse(raw.toString("utf8")) as {
    artifacts?: Array<unknown>
    descriptor?: { name?: unknown }
    distro?: { prettyName?: unknown }
  }
  if (
    document.descriptor?.name !== "syft" ||
    !Array.isArray(document.artifacts)
  ) {
    throw new Error("The Relay sent something other than a Syft inventory")
  }
  return {
    distro:
      typeof document.distro?.prettyName === "string"
        ? document.distro.prettyName
        : null,
    document: gzipped,
    packageCount: document.artifacts.length,
  }
}

// Brings Grype's database up to date when it's due, downloading it the first
// time an inventory needs it. Answers when it was built.
const currentDatabaseEffect = Effect.fnUntraced(function* () {
  const grype = yield* Grype
  const now = yield* Clock.currentTimeMillis
  const state = (globalThis.kilnSecurityDatabase ??= {
    builtAt: null,
    checkedAt: 0,
    failure: null,
  })
  if (state.builtAt === null) state.builtAt = yield* grype.databaseBuiltAt()
  if (
    state.builtAt === null ||
    now - state.checkedAt >= databaseCheckIntervalMs
  ) {
    state.checkedAt = now
    const updated = yield* grype.updateDatabase().pipe(Effect.result)
    if (updated._tag === "Failure") {
      if (state.failure !== updated.failure.message) {
        state.failure = updated.failure.message
        yield* Effect.logWarning("Could not update Grype's database").pipe(
          Effect.annotateLogs({ "error.message": updated.failure.message })
        )
      }
    } else {
      state.failure = null
    }
    state.builtAt = yield* grype.databaseBuiltAt()
  }
  return state.builtAt
})

// Checks every inventory not yet checked against the current database, and
// tells people what's new. Answers the Relays whose findings changed.
const matchPendingEffect = Effect.fnUntraced(function* () {
  if (!(yield* hasInventoriesEffect())) return new Set<string>()
  const builtAt = yield* currentDatabaseEffect()
  const touched = new Set<string>()
  if (builtAt === null) return touched
  const grype = yield* Grype
  const deadline = (yield* Clock.currentTimeMillis) + matchBudgetMs
  for (;;) {
    const pending = yield* pendingMatchesEffect(builtAt)
    if (!pending.length) break
    for (const { relayId, sbomKey } of pending) {
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        Queue.offerUnsafe(wake, undefined)
        return touched
      }
      const document = yield* loadInventoryDocumentEffect(relayId, sbomKey)
      if (document === null) continue
      const matched = yield* grype
        .match(gunzipSync(document))
        .pipe(Effect.withSpan("Security.match"), Effect.result)
      if (matched._tag === "Failure") {
        yield* recordMatchFailureEffect(
          relayId,
          sbomKey,
          matched.failure.message
        )
      } else {
        yield* recordFindingsEffect(relayId, sbomKey, builtAt, matched.success)
      }
      touched.add(relayId)
    }
  }
  return touched
})

// The findings a person wants to hear about, per their settings.
function wanted(
  findings: ReadonlyArray<AnnouncedFinding>,
  settings: SecurityNotificationSettings
): Array<AnnouncedFinding> {
  const least = severityRank(settings.severity)
  // One being exploited in the wild is worth hearing about either way.
  return findings.filter(
    (finding) =>
      finding.knownExploited ||
      (finding.severity >= least && (!settings.fixableOnly || finding.fixable))
  )
}

const announceEffect = Effect.fn("Security.announce")(function* (
  relayId: string
) {
  const database = yield* Database
  // One announcer per Relay at a time: another Hearth's waits for this one,
  // then finds its news told. Each person's report and what's recorded as
  // told commit together, so a failure partway tells nobody twice.
  const notified = yield* database.transaction("Security.announce", (tx) =>
    Effect.gen(function* () {
      yield* tx.queryRows(
        `SELECT id FROM ${databaseTable("relay")} WHERE id = ? FOR UPDATE`,
        [relayId]
      )
      const { announcements, changes } =
        yield* pendingSecurityAnnouncementsEffect(relayId)
      const news = announcements.length
        ? yield* newsEffect(relayId, announcements)
        : new Map<string, Array<ResourceNews>>()
      for (const [userId, items] of news)
        yield* replaceNotificationEffect(userId, "security.report", (unread) =>
          reportContent(items, unread)
        )
      yield* recordSecurityAnnouncementsEffect(relayId, changes)
      return [...news.keys()]
    })
  )
  publishNotificationChange(notified)
})

// What each person wants to hear of, per resource.
const newsEffect = Effect.fnUntraced(function* (
  relayId: string,
  announcements: ReadonlyArray<SecurityAnnouncement>
) {
  const names = yield* securityResourceNamesEffect(relayId)
  const news = new Map<string, Array<ResourceNews>>()
  for (const announcement of announcements) {
    const { resourceId, resourceType } = announcement
    const recipients = yield* resourceAudienceEffect(
      { relayId, resourceId, resourceType },
      securityNotifyPermissions[resourceType]
    )
    // Whether it reaches their inbox and devices is the notification's own
    // choice; which vulnerabilities notify at all is the security one.
    const preferences = yield* loadNotificationPreferencesEffect(recipients)
    for (const userId of recipients) {
      const findings = wanted(
        announcement.findings,
        preferences.get(userId)?.security ?? defaultSecurityNotificationSettings
      )
      if (!findings.length) continue
      const resource = {
        id: resourceId,
        name:
          names.get(`${resourceType}:${resourceId}`) ??
          (resourceType === "relay" ? "Relay" : resourceId.slice(0, 8)),
        relayId,
        type: resourceType,
      }
      news.set(userId, [...(news.get(userId) ?? []), { findings, resource }])
    }
  }
  return news
})

interface ResourceNews {
  findings: ReadonlyArray<AnnouncedFinding>
  resource: NotificationResource
}

// The report for this news, adding in the unread reports it replaces.
function reportContent(
  news: ReadonlyArray<ResourceNews>,
  unread: ReadonlyArray<NotificationContent>
): NotificationContent {
  const resources = new Map<string, NotificationResource>()
  let count = 0
  let knownExploited = 0
  let severity = 0
  for (const previous of unread) {
    if (previous.kind !== "security.report") continue
    count += previous.count
    knownExploited += previous.knownExploited
    severity = Math.max(severity, severityRank(previous.severity))
    for (const resource of previous.resources)
      resources.set(resourceKey(resource), resource)
  }
  for (const { findings, resource } of news) {
    count += distinctVulnerabilities(findings)
    knownExploited += distinctVulnerabilities(
      findings.filter((finding) => finding.knownExploited)
    )
    for (const finding of findings)
      severity = Math.max(severity, finding.severity)
    resources.set(resourceKey(resource), resource)
  }
  return {
    count,
    kind: "security.report",
    knownExploited,
    resources: [...resources.values()],
    severity: severityAt(severity),
  }
}

function resourceKey(resource: NotificationResource): string {
  return `${resource.type}:${resource.relayId}:${resource.id}`
}

function distinctVulnerabilities(
  findings: ReadonlyArray<AnnouncedFinding>
): number {
  return new Set(findings.map((finding) => finding.vulnerabilityId)).size
}

function publishSecurityChange(relayIds: Iterable<string>): void {
  const ids = [...relayIds]
  if (!ids.length) return
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: ids },
    topics: ["security"],
    type: "hearth.invalidate",
  })
}

const report = (operation: string, attributes: Record<string, string> = {}) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    logException(Cause.squash(cause), { attributes, operation })
  )

export function startSecurityScans(): void {
  // Relays whose news wasn't delivered, announced again each sweep until it
  // is. All of them at first, for what a restart interrupted.
  let owed: Set<string> | null = null
  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const changed = new Set<string>()
    const relays = yield* listPersistedRelaysEffect()
    owed ??= new Set(relays.map((relay) => relay.id))
    for (const relay of relays) {
      if (!inventories(relay)) continue
      if (now - (synced.get(relay.id) ?? 0) < syncIntervalMs) continue
      synced.set(relay.id, now)
      yield* syncRelayEffect(relay).pipe(
        Effect.tap(({ busy, more }) =>
          Effect.sync(() => {
            if (busy) synced.set(relay.id, now - syncIntervalMs + busyRetryMs)
            else if (more) {
              // Due again in the next sweep, which comes at once.
              synced.set(relay.id, now - syncIntervalMs)
              Queue.offerUnsafe(wake, undefined)
            }
            changed.add(relay.id)
          })
        ),
        Effect.withSpan("Security.syncRelay", {
          attributes: { "relay.id": relay.id },
        }),
        report("Security.syncRelay", { "relay.id": relay.id })
      )
    }
    const matched = yield* matchPendingEffect().pipe(
      Effect.provide(Grype.layer),
      Effect.catchCause((cause) =>
        logException(Cause.squash(cause), {
          operation: "Security.match",
        }).pipe(Effect.as(new Set<string>()))
      )
    )
    for (const relayId of matched) changed.add(relayId)
    // Announced after every sync too: a new game server may run an image
    // whose findings are already known.
    for (const relayId of new Set([...owed, ...changed])) {
      owed.add(relayId)
      yield* announceEffect(relayId).pipe(
        Effect.tap(() => Effect.sync(() => owed?.delete(relayId))),
        report("Security.announce", { "relay.id": relayId })
      )
    }
    publishSecurityChange(changed)
  }).pipe(report("Security.sweep"))
  // The first sweep waits a little, so Relays have connected. Each next one
  // comes after the interval, or sooner when someone scans now.
  globalThis.kilnSecurityScanner ??= forkAppWorker(
    Effect.sleep("1 minute").pipe(
      Effect.andThen(
        sweep.pipe(
          Effect.andThen(
            Effect.raceFirst(
              Effect.sleep(sweepInterval),
              Queue.take(wake).pipe(Effect.andThen(Effect.sleep("2 seconds")))
            )
          ),
          Effect.forever
        )
      ),
      Effect.asVoid
    )
  )
}

export function stopSecurityScans(): Promise<void> {
  const scanner = globalThis.kilnSecurityScanner
  globalThis.kilnSecurityScanner = undefined
  return scanner
    ? Effect.runPromise(Fiber.interrupt(scanner))
    : Promise.resolve()
}

// A dev reload of this module or one it imports replaces a running worker.
if (import.meta.hot) {
  if (import.meta.hot.data.running) startSecurityScans()
  import.meta.hot.dispose((data) => {
    data.running = globalThis.kilnSecurityScanner !== undefined
    void stopSecurityScans()
  })
}
