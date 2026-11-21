import { createHash } from "node:crypto"

import {
  RELAY_VOLUME_NAME_MAX_LENGTH,
  relayVolumeSchema,
  volumeTransferRootId,
  type RelayVolume,
} from "@workspace/contracts"
import { Effect } from "effect"

import { promiseEffect } from "@/effect/promise"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import {
  fail,
  relay,
  type MigratedKind,
} from "@/lib/resource-migration-kinds/kind.server"
import { readRelayVolumes } from "@/server/app-backups.server"

// A Kiln volume is its Relay's: Hearth keeps no record of one, it has no
// owner or access of its own, and nothing about it is stopped or started.
// Its copy is a new volume its Relay makes, filled with the archive a
// backup of the old one is, and copying one takes what backing it up and
// restoring it do, on the Relay, as they do.
export const volumes: MigratedKind = {
  kind: "volume",
  noun: "volume",
  nameLimit: RELAY_VOLUME_NAME_MAX_LENGTH,
  powered: false,
  copiedRunning: false,
  permissions: {
    copy: ["relay.read", "backup.create", "backup.download"],
    create: ["relay.configure", "backup.restore"],
    delete: "relay.configure",
  },
  // Made from the key alone, so asking again names the same volume.
  reserveId: (createKey) =>
    Effect.succeed(
      createHash("sha1").update(`kiln.volume.copy\n${createKey}`).digest("hex")
    ),
  describe: async (source, id, subject) => {
    const volume = await relayVolume(source, id, subject)
    return (
      volume && {
        limits: null,
        name: volume.name,
        provisioning: false,
        // It has no power of its own; what runs on it is warned about.
        running: false,
        unbuildable: null,
        usedBytes: volume.sizeBytes,
        usedFrom: "running" as const,
      }
    )
  },
  takenNames: async (destination, subject) =>
    (await readRelayVolumes(destination, subject)).volumes.map(
      (volume) => volume.name
    ),
  // One that is there is made: nothing provisions it, and it never runs.
  state: (source, id, subject) =>
    promiseEffect(() => relayVolume(source, id, subject)).pipe(
      Effect.map(
        (volume) => volume && { provisioning: null, ready: true, stopped: true }
      )
    ),
  // Its Relay's word is the only record of one.
  recorded: (relayId, id) =>
    relay(relayId).pipe(
      Effect.flatMap((there) =>
        promiseEffect(() => relayVolume(there, id, undefined))
      ),
      Effect.map((volume) => volume !== null)
    ),
  prepare: Effect.fnUntraced(function* (
    { destination, source },
    migration,
    actor,
    options
  ) {
    const volume = yield* promiseEffect(() =>
      relayVolume(source, migration.source.id, actor.id)
    )
    if (!volume) {
      return yield* fail(`${migration.source.name} is no longer on its Relay`)
    }
    // Before anything is copied: its Relay deletes none that is in use.
    if (options.deleteSource && inUse(volume)) {
      return yield* fail(
        `${volume.name} is in use on ${source.name}, so it can't be deleted after it's moved. Take it out of what uses it first, or move it without deleting it.`
      )
    }
    return promiseEffect(async () => {
      const { relayRpc } = await import("@/lib/relay-connection")
      relayVolumeSchema.parse(
        await relayRpc(
          destination,
          "relay.volumes.create",
          { id: migration.destination.id, name: migration.destination.name },
          30_000,
          actor.id
        )
      )
      publishRealtimeChange({
        audience: { kind: "relays", relayIds: [destination.id] },
        scope: { relayId: destination.id },
        topics: ["relay-volumes"],
        type: "hearth.invalidate",
      })
    })
  }),
  sourceRoots: (_relayId, id) => Effect.succeed([volumeTransferRootId(id)]),
  parts: (migration) =>
    Effect.succeed([
      {
        destination: volumeTransferRootId(migration.destination.id),
        source: volumeTransferRootId(migration.source.id),
      },
    ]),
  handOver: {},
  handOverCounts: async () => ({
    access: 0,
    backups: { anywhere: 0, here: 0, total: 0 },
    domains: { managed: false, names: [] },
    webRoutes: [],
  }),
  warnings: async (source, id, subject) => {
    const volume = await relayVolume(source, id, subject)
    if (!volume) return { duplicate: [], migrate: [] }
    const running = volume.mounts.filter((mount) => mount.running)
    const live =
      running.length > 0
        ? [
            `${running.length === 1 ? `${running[0]!.container} is` : `${running.length} containers are`} running on it. What ${running.length === 1 ? "it writes" : "they write"} while it's copied may be carried half-written or not at all, so stop ${running.length === 1 ? "it" : "them"} first for an exact copy.`,
          ]
        : []
    const users = volume.users.length
    return {
      duplicate: [
        ...live,
        "The copy is a volume of its own: nothing mounts it until you choose it in an App's settings.",
      ],
      migrate: [
        ...live,
        ...(users > 0
          ? [
              `${users === 1 ? "1 App uses" : `${users} Apps use`} it on ${source.name}. ${users === 1 ? "It keeps" : "They keep"} the old volume there: nothing is pointed at the copy for you.`,
            ]
          : [
              "Nothing mounts the copy until you choose it in an App's settings.",
            ]),
        `The old volume stays on ${source.name} until you delete it.`,
      ],
    }
  },
}

// Whether anything names or mounts it, so its Relay wouldn't delete it.
function inUse(volume: RelayVolume): boolean {
  return volume.users.length > 0 || volume.mounts.length > 0
}

// One Kiln volume as its Relay lists it, or null when it has none.
async function relayVolume(
  source: PersistedRelay,
  id: string,
  subject: string | undefined
): Promise<RelayVolume | null> {
  const { volumes: listed } = await readRelayVolumes(source, subject)
  return (
    listed.find((volume) => volume.kind === "kiln" && volume.id === id) ?? null
  )
}
