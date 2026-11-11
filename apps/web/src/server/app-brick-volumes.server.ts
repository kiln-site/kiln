import { createHash } from "node:crypto"

import {
  RELAY_VOLUME_NAME_MAX_LENGTH,
  relayVolumeSchema,
  type AppMount,
} from "@workspace/contracts"

import type { AuthenticatedUser } from "@/lib/auth-session"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { exclusive, resourceKey } from "@/operations/lanes"
import { databaseRpc } from "@/server/managed-database-access"

// The folders an App's Brick keeps. Installing the App makes a volume for
// each and mounts it there before the first deployment, so nothing it
// writes is ever kept in a container that a deployment replaces. They are
// ordinary Kiln volumes: no App's, shared and backed up like any other,
// and never deleted with the App unless whoever deletes it says so.

/** A volume an install makes for a folder its Brick keeps. */
export interface BrickVolume {
  /** The folder of the container it is mounted at. */
  folder: string
  id: string
  name: string
}

/**
 * The volumes an App's install makes, one for each folder its Brick keeps.
 * Each has the ID its App and folder give it, so every try of one install
 * makes the same volumes, and what it holds is settled before it runs.
 */
export function brickVolumes(
  app: { id: string; name: string },
  folders: ReadonlyArray<string>
): Array<BrickVolume> {
  return folders.map((folder) => {
    // Named after its App and the folder, as far as a name goes.
    const kept = folder.slice(folder.lastIndexOf("/") + 1)
    const room = Math.max(0, RELAY_VOLUME_NAME_MAX_LENGTH - kept.length - 1)
    const name = `${app.name.slice(0, room)} ${kept}`
    return {
      folder,
      id: createHash("sha1")
        .update(`kiln.brick.volume\n${app.id}\n${folder}`)
        .digest("hex"),
      name: name.trim().slice(0, RELAY_VOLUME_NAME_MAX_LENGTH),
    }
  })
}

/** What making them holds: each volume, by the ID it was given. */
export const brickVolumeLocks = (
  relayId: string,
  volumes: ReadonlyArray<BrickVolume>
) => volumes.map(({ id }) => exclusive(resourceKey("volume", relayId, id)))

/** Where an App's configuration mounts them: each at its folder, writable. */
export const brickVolumeMounts = (
  volumes: ReadonlyArray<BrickVolume>
): Array<AppMount> =>
  volumes.map(({ folder, id }) => ({
    id: id.slice(0, 16),
    readOnly: false,
    service: null,
    source: { type: "volume", volumeId: id },
    target: folder,
  }))

/**
 * Has the Relay make them. Asked again, it answers with those already
 * made. One made for an App that then couldn't be stays, empty, on its
 * Relay's volumes: the same install tried again uses it.
 */
export async function makeBrickVolumes(
  user: AuthenticatedUser,
  relay: PersistedRelay,
  volumes: ReadonlyArray<BrickVolume>
): Promise<void> {
  if (volumes.length === 0) return
  for (const { id, name } of volumes) {
    relayVolumeSchema.parse(
      await databaseRpc(
        relay,
        "relay.volumes.create",
        { id, name },
        30_000,
        user.id
      )
    )
  }
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relay.id] },
    scope: { relayId: relay.id },
    topics: ["relay-volumes"],
    type: "hearth.invalidate",
  })
}
