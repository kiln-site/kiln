import type { AppConfig } from "@workspace/contracts"
import { Effect } from "effect"

import { promiseEffect } from "@/effect/promise"

// A Relay refuses to delete a Kiln volume an App's configuration mounts,
// deployed or not, so it keeps which volumes each configuration names, as
// each paired Hearth says. Hearth saves configurations, so it tells the
// Relay each App's whole set around every save, and every App's whenever
// it connects (see `importRelayAppVolumeReferencesEffect`).

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

/**
 * Sends every App's configured volumes Hearth keeps for a Relay, in place
 * of all it sent before, with the Apps whose configurations it couldn't
 * read.
 */
export const importAppVolumeReferencesEffect = Effect.fn(
  "apps.volumeReferences.import"
)(function* (
  relayId: string,
  apps: ReadonlyArray<{ appId: string; volumeIds: ReadonlyArray<string> }>,
  unresolvedAppIds: ReadonlyArray<string>
) {
  yield* Effect.annotateCurrentSpan({
    "kiln.app_count": apps.length,
    "kiln.app_unresolved_count": unresolvedAppIds.length,
  })
  yield* relayRequest(relayId, "relay.volumes.references.import", {
    apps,
    unresolvedAppIds,
  })
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
