import {
  appFileRootId,
  type IconImageContentType,
  primaryWebRoute,
  relayAppWebRouteStateSchema,
  relayIconMaxBytes,
  relayIconReadResultSchema,
  relayIconReadV1Feature,
  sniffIconImage,
} from "@workspace/contracts"
import { logException } from "@workspace/telemetry"
import { Cause, Clock, Effect, Fiber, Schedule } from "effect"

import {
  listDetectionsEffect,
  listLinkedIconsEffect,
  saveIconEffect,
  removeIconsEffect,
  shownIconDigestEffect,
  touchDetectedIconEffect,
} from "@/effect/icons"
import { listAppRecordsEffect } from "@/effect/managed-apps"
import { promiseEffect } from "@/effect/promise"
import { forkAppWorker } from "@/effect/runtime"
import { fetchPublicHttps } from "@/lib/public-https.server"
import {
  SERVER_ICON_PATH,
  type IconOrigin,
  type IconSubject,
  type InstanceIconSubject,
} from "@/lib/icons"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import {
  relayConnectionFeatures,
  relayConnectionInstances,
  relayRpc,
} from "@/lib/relay-connection"
import {
  listPersistedRelaysEffect,
  type PersistedRelay,
} from "@/lib/relay-registry"
import {
  conventionalIcons,
  rankSiteIcons,
  readManifestIcons,
  readSitePage,
} from "@/lib/site-icons"

// A custom icon copied from a game server's or app's file follows that
// file: each sweep reads it again when it changed, so replacing the file
// replaces the icon.
//
// Hearth also looks for icons nobody chose: a game server's `server-icon.png`,
// where Minecraft keeps it, and the largest icon an app's site has, named
// by its pages or manifest or kept where sites keep them, trying its
// domains, its primary one first. Game servers are looked
// at every few minutes, since reading one unchanged file is cheap; sites
// a few times a day, and whenever someone asks.

const sweepInterval = "5 minutes"
const siteCheckIntervalMs = 6 * 60 * 60_000
const relayReadTimeoutMs = 15_000
const SITE_PAGE_MAX_BYTES = 512 * 1024
const SITE_MANIFEST_MAX_BYTES = 128 * 1024
// Icons a site might have are tried this many at a time, each briefly.
const SITE_PROBE_BATCH = 4
const SITE_PROBE_TIMEOUT_MS = 5_000
// How many of an app's domains to look at before giving up.
const SITE_ROUTE_ATTEMPTS = 3

declare global {
  var kilnIconDetector: Fiber.Fiber<void> | undefined
}

/** Tells everyone who may see it that a subject's shown icon changed. */
export function publishIconChange(subject: IconSubject): void {
  publishRealtimeChange({
    audience:
      subject.kind === "user"
        ? { kind: "authenticated" }
        : { kind: "relays", relayIds: [subject.relayId] },
    topics: ["icons"],
    type: "hearth.invalidate",
  })
}

export function readsIcons(relayId: string): boolean {
  return relayConnectionFeatures(relayId).has(relayIconReadV1Feature)
}

/**
 * Reads an image for an icon from a Relay: a file under a game server's or
 * app's files, or one inside an app service's container. Null when nothing
 * is at the path.
 */
export const readRelayIconEffect = Effect.fn("Icons.readRelay")(function* (
  relay: PersistedRelay,
  input:
    | { readonly instanceId: string; readonly path: string }
    | {
        readonly appId: string
        readonly path: string
        readonly service: string
      },
  subject?: string
) {
  if (!readsIcons(relay.id)) {
    return yield* Effect.fail(
      new Error("Update this Relay to read icons from its files")
    )
  }
  const result = relayIconReadResultSchema.parse(
    yield* promiseEffect(() =>
      relayRpc(relay, "instance.icon.read", input, relayReadTimeoutMs, subject)
    )
  )
  if (!result) return null
  const bytes = Buffer.from(result.contentBase64, "base64")
  const contentType = sniffIconImage(bytes)
  if (!contentType) {
    return yield* Effect.fail(new Error("That file isn't an image"))
  }
  return {
    bytes,
    contentType,
    version: `${result.modifiedAt}:${result.size}`,
  }
})

/** Looks at a game server's `server-icon.png`, unless it's unchanged. */
const detectServerIconEffect = Effect.fn("Icons.detectServer")(function* (
  relay: PersistedRelay,
  serverId: string,
  previousVersion: string | null
) {
  const subject: InstanceIconSubject = {
    kind: "server",
    relayId: relay.id,
    id: serverId,
  }
  const icon = yield* readRelayIconEffect(relay, {
    instanceId: serverId,
    path: SERVER_ICON_PATH,
  })
  if (icon && icon.version === previousVersion) {
    yield* touchDetectedIconEffect(subject)
    return false
  }
  return yield* saveIconEffect(subject, "detected", {
    contentType: icon?.contentType ?? null,
    image: icon?.bytes ?? null,
    origin: icon ? { type: "file", path: SERVER_ICON_PATH } : null,
    originVersion: icon?.version ?? null,
  })
})

interface SiteIcon {
  readonly bytes: Buffer
  readonly contentType: IconImageContentType
  readonly url: string
}

/** The largest icon a site has: one it names, or one where sites keep them. */
const findSiteIconEffect = Effect.fn("Icons.findSiteIcon")(function* (
  pageUrl: URL
): Effect.fn.Return<SiteIcon | null> {
  const page = yield* promiseEffect(() =>
    fetchPublicHttps(pageUrl, {
      accept: "text/html,application/xhtml+xml",
      maxBytes: SITE_PAGE_MAX_BYTES,
      // Icons are named in the page's head.
      truncate: true,
    })
  ).pipe(Effect.option)
  const named =
    page._tag === "Some" && page.value.contentType?.includes("html") !== false
      ? readSitePage(page.value.body.toString("utf8"), page.value.url.href)
      : { icons: [], manifestUrl: null }
  const manifest = named.manifestUrl
    ? yield* promiseEffect(() =>
        fetchPublicHttps(named.manifestUrl ?? "", {
          accept: "application/manifest+json,application/json",
          maxBytes: SITE_MANIFEST_MAX_BYTES,
          timeoutMs: SITE_PROBE_TIMEOUT_MS,
        })
      ).pipe(
        Effect.flatMap((response) =>
          Effect.try(() => JSON.parse(response.body.toString("utf8")) as unknown)
        ),
        Effect.map((json) => readManifestIcons(json, named.manifestUrl ?? "")),
        Effect.orElseSucceed(() => [])
      )
    : []
  const candidates = rankSiteIcons([
    ...named.icons,
    ...manifest,
    ...conventionalIcons(page._tag === "Some" ? page.value.url.href : pageUrl.href),
  ])
  // A few at a time, largest first; most guessed spots don't exist, so the
  // first batch with an image settles it.
  for (let start = 0; start < candidates.length; start += SITE_PROBE_BATCH) {
    const batch = candidates.slice(start, start + SITE_PROBE_BATCH)
    const images = yield* Effect.forEach(
      batch,
      (candidate) =>
        promiseEffect(() =>
          fetchPublicHttps(candidate.url, {
            accept: "image/*",
            maxBytes: relayIconMaxBytes,
            timeoutMs: SITE_PROBE_TIMEOUT_MS,
          })
        ).pipe(
          Effect.map((image) => {
            const contentType = sniffIconImage(image.body)
            return contentType
              ? { bytes: image.body, contentType, url: candidate.url }
              : null
          }),
          Effect.orElseSucceed(() => null)
        ),
      { concurrency: SITE_PROBE_BATCH }
    )
    const found = images.find((image) => image !== null)
    if (found) return found
  }
  return null
})

/**
 * Looks for an app's icon on its domains, its primary one first, then in
 * the order its web routes list them, until one has an icon.
 */
const detectAppIconEffect = Effect.fn("Icons.detectApp")(function* (
  relay: PersistedRelay,
  appId: string
) {
  const subject: InstanceIconSubject = {
    kind: "app",
    relayId: relay.id,
    id: appId,
  }
  const state = relayAppWebRouteStateSchema.parse(
    yield* promiseEffect(() =>
      relayRpc(relay, "app.network.routes.read", { appId }, relayReadTimeoutMs)
    )
  )
  // The primary route first; a redirect serves another site, not the app.
  const primary = primaryWebRoute(state.routes)
  const serving = state.routes.filter(
    (route) => !route.redirect && route !== primary
  )
  const sites = [
    ...new Map(
      (primary ? [primary, ...serving] : serving).map((route) => {
        const url = `https://${route.hostname}${route.path ?? "/"}`
        return [url, new URL(url)] as const
      })
    ).values(),
  ].slice(0, SITE_ROUTE_ATTEMPTS)
  let icon: SiteIcon | null = null
  for (const site of sites) {
    icon = yield* findSiteIconEffect(site)
    if (icon) break
  }
  return yield* saveIconEffect(subject, "detected", {
    contentType: icon?.contentType ?? null,
    image: icon?.bytes ?? null,
    origin: icon ? { type: "site", url: icon.url } : null,
    originVersion: sites[0] ? (sites[0].host + sites[0].pathname).slice(0, 64) : null,
  })
})

type LinkedFile = Extract<IconOrigin, { type: "file" }>

/**
 * Copies the file a custom icon follows, unless it's unchanged. A file
 * that's gone leaves the icon without an image, so the detected or default
 * one shows until the file is back; one that can't be read right now keeps
 * the last copy. `actor` reads with someone's own access, as when they
 * link the file.
 */
export const refreshLinkedIconEffect = Effect.fn("Icons.refreshLinked")(
  function* (
    relay: PersistedRelay,
    subject: InstanceIconSubject & { kind: "app" | "server" },
    origin: LinkedFile,
    previousVersion: string | null,
    actor?: string
  ) {
    const icon = yield* readRelayIconEffect(
      relay,
      subject.kind === "app" && origin.service
        ? { appId: subject.id, path: origin.path, service: origin.service }
        : {
            instanceId:
              subject.kind === "app" ? appFileRootId(subject.id) : subject.id,
            path: origin.path.replace(/^\/+/u, ""),
          },
      actor
    )
    if (icon && icon.version === previousVersion) return false
    return yield* saveIconEffect(subject, "custom", {
      contentType: icon?.contentType ?? null,
      image: icon?.bytes ?? null,
      origin,
      originVersion: icon?.version ?? null,
    })
  }
)

const refreshLinkedIconsEffect = Effect.fn("Icons.refreshLinkedRelay")(
  function* (relay: PersistedRelay, subjectId?: string) {
    const linked = yield* listLinkedIconsEffect(relay.id, subjectId)
    return yield* Effect.forEach(
      linked,
      (icon) =>
        refreshLinkedIconEffect(
          relay,
          { kind: icon.kind, relayId: relay.id, id: icon.id },
          icon.origin,
          icon.originVersion
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("Linked icon refresh failed", Cause.pretty(cause)).pipe(
              Effect.as(false)
            )
          )
        ),
      { concurrency: 4 }
    )
  }
)

/** Looks for a game server's or app's icon now, as when someone asks. */
export const detectInstanceIconEffect = Effect.fn("Icons.detect")(function* (
  relay: PersistedRelay,
  subject: InstanceIconSubject
) {
  const detected =
    subject.kind === "server"
      ? yield* detectServerIconEffect(relay, subject.id, null)
      : subject.kind === "app"
        ? yield* detectAppIconEffect(relay, subject.id)
        : false
  // A custom icon that follows a file is read again too.
  const linked = yield* refreshLinkedIconsEffect(relay, subject.id)
  const changed = detected || linked.some(Boolean)
  if (changed) publishIconChange(subject)
  return changed
})

/**
 * Saves someone's chosen icon and answers the digest browsers show next,
 * so the one who chose it sees it without asking again.
 */
export const saveCustomIconEffect = Effect.fn("Icons.saveCustom")(function* (
  subject: IconSubject,
  input: Parameters<typeof saveIconEffect>[2]
) {
  yield* Effect.annotateCurrentSpan("kiln.icon.kind", subject.kind)
  const changed = yield* saveIconEffect(subject, "custom", input)
  if (changed) publishIconChange(subject)
  return yield* shownIconDigestEffect(subject)
})

/**
 * Removes someone's chosen icon. Only Hearth's copy goes; the file a linked
 * icon follows is never touched. A game server falls back to its
 * `server-icon.png`, so that's read again first, or a stale copy would
 * look as though removing did nothing.
 */
export const removeCustomIconEffect = Effect.fn("Icons.removeCustom")(
  function* (relay: PersistedRelay | null, subject: IconSubject) {
    yield* Effect.annotateCurrentSpan("kiln.icon.kind", subject.kind)
    const removed = yield* removeIconsEffect(subject, "custom")
    if (removed && relay && subject.kind === "server" && readsIcons(relay.id)) {
      yield* detectServerIconEffect(relay, subject.id, null).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug(
            "Server icon recheck failed",
            Cause.pretty(cause)
          ).pipe(Effect.as(false))
        )
      )
    }
    if (removed) publishIconChange(subject)
    return yield* shownIconDigestEffect(subject)
  }
)

const detectRelayIconsEffect = Effect.fn("Icons.detectRelay")(function* (
  relay: PersistedRelay
) {
  const now = yield* Clock.currentTimeMillis
  const servers = (relayConnectionInstances(relay.id) ?? []).filter(
    (instance) => !instance.provisioning
  )
  const serverDetections = yield* listDetectionsEffect("server", relay.id)
  const appDetections = yield* listDetectionsEffect("app", relay.id)
  const apps = (yield* listAppRecordsEffect()).filter(
    (app) =>
      app.relayId === relay.id &&
      now - (appDetections.get(app.appId)?.checkedAt ?? 0) >=
        siteCheckIntervalMs
  )
  const changes = yield* Effect.forEach(
    [
      ...servers.map((server) =>
        detectServerIconEffect(
          relay,
          server.id,
          serverDetections.get(server.id)?.originVersion ?? null
        )
      ),
      ...apps.map((app) => detectAppIconEffect(relay, app.appId)),
    ].map((detection) =>
      detection.pipe(
        // One that fails is looked at again next time.
        Effect.catchCause((cause) =>
          Effect.logDebug("Icon detection failed", Cause.pretty(cause)).pipe(
            Effect.as(false)
          )
        )
      )
    ),
    (detection) => detection,
    { concurrency: 4 }
  )
  const linked = yield* refreshLinkedIconsEffect(relay)
  if (changes.some(Boolean) || linked.some(Boolean)) {
    publishRealtimeChange({
      audience: { kind: "relays", relayIds: [relay.id] },
      topics: ["icons"],
      type: "hearth.invalidate",
    })
  }
})

export function startIconDetection(): void {
  const sweep = Effect.gen(function* () {
    for (const relay of yield* listPersistedRelaysEffect()) {
      if (!relay.enabled || !readsIcons(relay.id)) continue
      yield* detectRelayIconsEffect(relay).pipe(
        Effect.catchCause((cause) =>
          logException(Cause.squash(cause), {
            operation: "Icons.detectRelay",
            attributes: { "relay.id": relay.id },
          })
        )
      )
    }
  }).pipe(
    Effect.catchCause((cause) =>
      logException(Cause.squash(cause), { operation: "Icons.sweep" })
    )
  )
  // The first sweep waits a little, so Relays have connected.
  globalThis.kilnIconDetector ??= forkAppWorker(
    Effect.sleep("30 seconds").pipe(
      Effect.andThen(sweep.pipe(Effect.repeat(Schedule.spaced(sweepInterval)))),
      Effect.asVoid
    )
  )
}

export function stopIconDetection(): Promise<void> {
  const detector = globalThis.kilnIconDetector
  globalThis.kilnIconDetector = undefined
  return detector
    ? Effect.runPromise(Fiber.interrupt(detector))
    : Promise.resolve()
}

if (import.meta.hot) import.meta.hot.dispose(() => stopIconDetection())
