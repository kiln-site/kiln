import { randomBytes } from "node:crypto"
import { createServerFn } from "@tanstack/react-start"
import {
  RELAY_VOLUME_REFERENCES_PENDING,
  relayIdSchema,
  relayVolumeIdSchema,
  relayVolumeNameSchema,
  relayVolumeSchema,
  relayVolumesSchema,
  relayVolumesV1Feature,
} from "@workspace/contracts"
import { z } from "zod"

import { importRelayAppVolumeReferencesEffect } from "@/effect/managed-apps"
import { runAppEffect } from "@/effect/runtime"
import { deleteConfirmationSchema } from "@/lib/delete-confirmation"
import { requireDeleteConfirmation } from "@/lib/delete-confirmation.server"
import {
  awaitResourceDeletion,
  requestResourceDeletion,
} from "@/lib/resource-deletion.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { requireBackupTargetPermission } from "@/server/backup-target-access.server"
import { databaseRpc } from "@/server/managed-database-access"
import { authorizedRelay } from "@/server/relay-access"

const targetSchema = z.object({ relayId: relayIdSchema })
const volumeSchema = targetSchema.extend({ volumeId: relayVolumeIdSchema })

// A Relay's Docker named volumes, with what mounts and uses each, what Apps
// mount that no volume Kiln manages holds, and whether the Relay knows yet
// which volumes every Hearth's Apps' configurations name; Hearth sends its
// own when it connects. Docker measures every volume for their sizes, so
// this can take a while.
export const getRelayVolumes = createServerFn({ method: "GET" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const { relay } = await authorizedRelay(data.relayId, "relay.read")
    if (!(await relayHasVolumes(relay.id))) {
      return {
        measuring: false,
        protection: { ready: true, reason: null, retrying: false },
        supported: false,
        uncovered: [],
        volumes: [],
      }
    }
    const { measuring, protection, uncovered, volumes } =
      relayVolumesSchema.parse(
        await databaseRpc(relay, "relay.volumes.read", {}, 30_000)
      )
    // This Hearth's own import failed and is being sent again.
    const { relayVolumeReferencesState } =
      await import("@/lib/relay-connection")
    const retrying =
      !protection.ready && relayVolumeReferencesState(relay.id) === "retrying"
    return {
      measuring,
      protection: { ...protection, retrying },
      supported: true,
      uncovered,
      volumes,
    }
  })

export const createRelayVolume = createServerFn({ method: "POST" })
  .validator(targetSchema.extend({ name: relayVolumeNameSchema }))
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedRelay(
      data.relayId,
      "relay.configure"
    )
    await requireRelayVolumes(relay.id)
    const volume = relayVolumeSchema.parse(
      await databaseRpc(
        relay,
        "relay.volumes.create",
        { id: randomBytes(20).toString("hex"), name: data.name },
        30_000,
        user.id
      )
    )
    publishRelayVolumesChange(relay.id)
    return volume
  })

export const renameRelayVolume = createServerFn({ method: "POST" })
  .validator(volumeSchema.extend({ name: relayVolumeNameSchema }))
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedRelay(
      data.relayId,
      "relay.configure"
    )
    await requireRelayVolumes(relay.id)
    await databaseRpc(
      relay,
      "relay.volumes.rename",
      { id: data.volumeId, name: data.name },
      30_000,
      user.id
    )
    publishRelayVolumesChange(relay.id)
    return { renamed: true }
  })

export const deleteRelayVolume = createServerFn({ method: "POST" })
  .validator(
    volumeSchema.extend(deleteConfirmationSchema.shape).extend({
      createBackup: z.boolean().default(true),
      storageId: z.uuid().nullable().optional(),
    })
  )
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedRelay(
      data.relayId,
      "relay.configure"
    )
    await requireRelayVolumes(relay.id)
    const volume = await deletableVolume(relay, data.volumeId)
    await requireDeleteConfirmation({
      confirmation: data.confirmation,
      name: volume.name,
      password: data.password,
      user,
    })
    if (data.createBackup) {
      await requireBackupTargetPermission(
        user,
        relay.id,
        { id: data.volumeId, kind: "volume" },
        "backup.create"
      )
    }
    // Frozen, backed up if asked, then deleted, as one operation that goes
    // on in the background if it outlasts this request.
    const deletion = await requestResourceDeletion({
      finalBackup: data.createBackup,
      kind: "volume",
      relayId: relay.id,
      resourceId: data.volumeId,
      user,
      ...(data.createBackup && data.storageId !== undefined
        ? { storageId: data.storageId }
        : {}),
    })
    await awaitResourceDeletion(deletion)
    publishRelayVolumesChange(relay.id)
    return { deleted: true }
  })

// The volume, refused while anything uses it, as its Relay refuses to
// freeze it then: an App's configuration that names it, deployed or not, or
// a container that mounts it. A Relay still waiting for this Hearth's Apps'
// configured volumes, as when a connect's import failed, gets them first;
// one waiting for another Hearth's still refuses.
async function deletableVolume(
  relay: Parameters<typeof databaseRpc>[0],
  volumeId: string
) {
  const read = async () =>
    relayVolumesSchema.parse(
      await databaseRpc(relay, "relay.volumes.read", {}, 30_000)
    )
  let listed = await read()
  if (!listed.protection.ready) {
    await importVolumeReferences(relay.id)
    listed = await read()
  }
  const volume = listed.volumes.find((candidate) => candidate.id === volumeId)
  if (!volume) throw new Error("Volume not found on this Relay")
  if (!listed.protection.ready) {
    throw new Error(
      `${RELAY_VOLUME_REFERENCES_PENDING}: ${listed.protection.reason}`
    )
  }
  const configured = volume.users.filter((user) => user.configured).length
  if (configured > 0) {
    throw new Error(
      configured === 1
        ? "An App's configuration mounts this volume; remove it there first"
        : `${configured} Apps' configurations mount this volume; remove it there first`
    )
  }
  const [first, ...others] = volume.mounts
  if (first) {
    throw new Error(
      others.length === 0
        ? `${first.container} mounts this volume; remove it first`
        : `${others.length + 1} containers mount this volume; remove them first`
    )
  }
  return volume
}

async function importVolumeReferences(relayId: string): Promise<void> {
  await runAppEffect(
    "relay.volumes.references.import",
    importRelayAppVolumeReferencesEffect(relayId)
  )
}

// An offline Relay has no features yet; asking it says why it can't answer.
async function relayHasVolumes(relayId: string): Promise<boolean> {
  const { relayConnectionFeatures } = await import("@/lib/relay-connection")
  const features = relayConnectionFeatures(relayId)
  return features.size === 0 || features.has(relayVolumesV1Feature)
}

// An older Relay doesn't know the operation, and wouldn't answer it.
async function requireRelayVolumes(relayId: string): Promise<void> {
  if (!(await relayHasVolumes(relayId))) {
    throw new Error("Update this Relay to manage its volumes.")
  }
}

function publishRelayVolumesChange(relayId: string): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { relayId },
    topics: ["relay-volumes"],
    type: "hearth.invalidate",
  })
}
