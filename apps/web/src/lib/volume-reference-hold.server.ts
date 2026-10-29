import { relayVolumesV1Feature } from "@workspace/contracts"

import {
  reconnectRelayConnections,
  relayConnectionFeatures,
  relayRpc,
} from "@/lib/relay-connection"
import { ensuringPromise, recoverPromise } from "@/effect/promise"
import { listPersistedRelays } from "@/lib/relay-registry"
import { holdVolumeReferences } from "@/lib/volume-reference-gate"

/**
 * Runs `replace`, which changes Hearth's database, with every Relay told
 * first that what this Hearth sent of its Apps' configurations no longer
 * counts: each waits for deletions already under way, then refuses to
 * delete a Kiln volume until Hearth sends them again. A Relay that can't be
 * told refuses the change, so none can count what Hearth no longer holds.
 * After, every connection starts again, and sends what Hearth holds then.
 */
export async function holdingRelayVolumeReferences<A>(
  replace: () => Promise<A>
): Promise<A> {
  const release = holdVolumeReferences()
  return ensuringPromise(
    async () => {
      const relays = await listPersistedRelays()
      const unreachable: Array<string> = []
      await Promise.all(
        relays.map(async (relay) => {
          const features = relayConnectionFeatures(relay.id)
          // A Relay from before volumes keeps no configurations to hold.
          if (features.size > 0 && !features.has(relayVolumesV1Feature)) {
            return
          }
          await recoverPromise(
            () => relayRpc(relay, "relay.volumes.references.hold", {}, 30_000),
            () => {
              unreachable.push(relay.name)
            }
          )
        })
      )
      if (unreachable.length > 0) {
        const one = unreachable.length === 1
        throw new Error(
          `Nothing was imported: ${unreachable.sort().join(", ")} couldn't be told that this Hearth's App configurations are changing, so ${one ? "it" : "they"} could delete a volume they name. Connect ${one ? "it" : "them"}, or remove ${one ? "it" : "them"} from Kiln, and try again.`
        )
      }
      return replace()
    },
    () => {
      release()
      reconnectRelayConnections()
    }
  )
}
