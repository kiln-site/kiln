import {
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
  saveIconEffect,
  touchDetectedIconEffect,
} from "@/effect/icons"
import { listAppRecordsEffect } from "@/effect/managed-apps"
import { promiseEffect } from "@/effect/promise"
import { forkAppWorker } from "@/effect/runtime"
import { fetchPublicHttps } from "@/lib/public-https.server"
import {
  SERVER_ICON_PATH,
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
import { siteIconCandidates } from "@/lib/site-icons"

// Hearth looks for icons nobody chose: a game server's `server-icon.png`,
// where Minecraft keeps it, and the icon an app's first domain names for
// itself, its largest, or else its `/favicon.ico`. Game servers are looked
// at every few minutes, since reading one unchanged file is cheap; sites
// a few times a day, and whenever someone asks.

const sweepInterval = "5 minutes"
const siteCheckIntervalMs = 6 * 60 * 60_000
const relayReadTimeoutMs = 15_000
const SITE_PAGE_MAX_BYTES = 512 * 1024
// How many of a page's icons to try before giving up on it.
const SITE_ICON_ATTEMPTS = 4

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

/** The icon an app's first domain names for itself, if it has one. */
const findSiteIconEffect = Effect.fn("Icons.findSiteIcon")(function* (
  pageUrl: URL
) {
  const page = yield* promiseEffect(() =>
    fetchPublicHttps(pageUrl, {
      accept: "text/html,application/xhtml+xml",
      maxBytes: SITE_PAGE_MAX_BYTES,
      // Icons are named in the page's head.
      truncate: true,
    })
  ).pipe(Effect.option)
  const candidates =
    page._tag === "Some" && page.value.contentType?.includes("html") !== false
      ? siteIconCandidates(
          page.value.body.toString("utf8"),
          page.value.url.href
        )
      : []
  const fallback = new URL("/favicon.ico", pageUrl).href
  const urls = [
    ...candidates.map((candidate) => candidate.url),
    ...(candidates.some((candidate) => candidate.url === fallback)
      ? []
      : [fallback]),
  ].slice(0, SITE_ICON_ATTEMPTS + 1)
  for (const url of urls) {
    const image = yield* promiseEffect(() =>
      fetchPublicHttps(url, {
        accept: "image/*",
        maxBytes: relayIconMaxBytes,
      })
    ).pipe(Effect.option)
    if (image._tag === "None") continue
    const contentType = sniffIconImage(image.value.body)
    if (contentType) return { bytes: image.value.body, contentType, url }
  }
  return null
})

/** Looks for the icon an app's first domain names for itself. */
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
  const route = state.routes[0]
  const icon = route
    ? yield* findSiteIconEffect(
        new URL(`https://${route.hostname}${route.path ?? "/"}`)
      )
    : null
  return yield* saveIconEffect(subject, "detected", {
    contentType: icon?.contentType ?? null,
    image: icon?.bytes ?? null,
    origin: icon ? { type: "site", url: icon.url } : null,
    originVersion: route ? `${route.hostname}${route.path ?? ""}` : null,
  })
})

/** Looks for a game server's or app's icon now, as when someone asks. */
export const detectInstanceIconEffect = Effect.fn("Icons.detect")(function* (
  relay: PersistedRelay,
  subject: InstanceIconSubject
) {
  const changed =
    subject.kind === "server"
      ? yield* detectServerIconEffect(relay, subject.id, null)
      : subject.kind === "app"
        ? yield* detectAppIconEffect(relay, subject.id)
        : false
  if (changed) publishIconChange(subject)
  return changed
})

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
  if (changes.some(Boolean)) {
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
