import type { AppConfig } from "@workspace/contracts"
import { Effect } from "effect"

import { promiseEffect } from "@/effect/promise"

// A Relay refuses to delete a Kiln volume an App's configuration mounts,
// deployed or not, so it keeps which volumes each configuration names.
// Hearth saves configurations, so it tells the Relay: of a volume a
// configuration takes up before saving it, of one it drops after, and of
// all of them once, for a Relay that has none yet.

const RELAY_TIMEOUT_MS = 30_000

/** The Kiln volumes a configuration mounts, each once. */
export function configuredVolumeIds(config: AppConfig): Array<string> {
  return [
    ...new Set(
      config.mounts.flatMap((mount) =>
        mount.source.type === "volume" ? [mount.source.volumeId] : []
      )
    ),
  ].sort()
}

/** Replaces the volumes the Relay holds one App's configuration names. */
export const sendAppVolumeReferencesEffect = Effect.fn(
  "apps.volumeReferences.send"
)(function* (relayId: string, appId: string, volumeIds: ReadonlyArray<string>) {
  yield* Effect.annotateCurrentSpan({ "kiln.app_id": appId })
  yield* relayRequest(relayId, "app.volumes.write", { appId, volumeIds })
})

/** Sends every App's configured volumes to a Relay that has none yet. */
export const importAppVolumeReferencesEffect = Effect.fn(
  "apps.volumeReferences.import"
)(function* (
  relayId: string,
  apps: ReadonlyArray<{ appId: string; volumeIds: ReadonlyArray<string> }>
) {
  yield* Effect.annotateCurrentSpan({ "kiln.app_count": apps.length })
  yield* relayRequest(relayId, "relay.volumes.references.import", { apps })
})

function relayRequest(
  relayId: string,
  operation: "app.volumes.write" | "relay.volumes.references.import",
  payload: unknown
) {
  return promiseEffect(async () => {
    const [{ activeRelay }, { relayRpc }] = await Promise.all([
      import("@/lib/relay-registry"),
      import("@/lib/relay-connection"),
    ])
    await relayRpc(
      await activeRelay(relayId),
      operation,
      payload,
      RELAY_TIMEOUT_MS
    )
  })
}
