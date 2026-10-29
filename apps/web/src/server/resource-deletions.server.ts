import { relayVolumesSchema, type AccessPermission } from "@workspace/contracts"

import { listAppRecordsEffect } from "@/effect/managed-apps"
import { listManagedDatabaseRecordsEffect } from "@/effect/managed-databases"
import {
  listResourceDeletionsOfKindEffect,
  type ResourceDeletion,
  type ResourceDeletionKind,
} from "@/effect/resource-deletions"
import { runAppEffect } from "@/effect/runtime"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  instanceDeletionName,
  requireDeleteConfirmation,
} from "@/lib/delete-confirmation.server"
import { relayRpc } from "@/lib/relay-connection"
import { activeRelay } from "@/lib/relay-registry"
import {
  cancelResourceDeletion,
  findResourceDeletion,
  requestResourceDeletion,
} from "@/lib/resource-deletion.server"
import { requireEligibleResourceUser } from "@/server/auth"
import { requireBackupTargetPermission } from "@/server/backup-target-access.server"

export interface ResourceDeletionTarget {
  kind: ResourceDeletionKind
  relayId: string
  resourceId: string
}

/** What a resource's page shows of its deletion, while it's running or stopped. */
export interface ResourceDeletionSummary {
  /** Whether it stopped after the Relay deleted it, so only cleanup is left. */
  deletedOnRelay: boolean
  /**
   * Whether its Relay was asked to delete it, so it can only be finished:
   * not kept, and without a new final backup.
   */
  deletionStarted: boolean
  error: string | null
  finalBackup: boolean
  status: "backing_up" | "cancelling" | "deleting" | "failed" | "pending"
}

// A Kiln volume is the Relay's: configuring the Relay deletes one.
function permissionFor(
  target: ResourceDeletionTarget,
  action: "delete" | "read"
): AccessPermission {
  switch (target.kind) {
    case "instance":
      return `instance.${action}`
    case "database":
      return `database.${action}`
    case "app":
      return `app.${action}`
    case "volume":
      return action === "delete" ? "relay.configure" : "relay.read"
  }
}

async function authorize(
  target: ResourceDeletionTarget,
  permissions: ReadonlyArray<AccessPermission>
): Promise<AuthenticatedUser> {
  const user = await requireEligibleResourceUser()
  for (const permission of permissions) {
    await requireRelayPermission({
      permission,
      relayId: target.relayId,
      user,
      ...(target.kind === "instance"
        ? { instanceId: target.resourceId }
        : target.kind === "database"
          ? { databaseId: target.resourceId }
          : target.kind === "app"
            ? { appId: target.resourceId }
            : {}),
    })
  }
  return user
}

// Taking its final backup: as backing it up by hand takes.
async function requireFinalBackupPermission(
  target: ResourceDeletionTarget,
  user: AuthenticatedUser
): Promise<void> {
  if (target.kind === "instance" || target.kind === "database") {
    await authorize(target, ["backup.create"])
    return
  }
  await requireBackupTargetPermission(
    user,
    target.relayId,
    { id: target.resourceId, kind: target.kind },
    "backup.create"
  )
}

function summarize(deletion: ResourceDeletion | null) {
  if (
    !deletion ||
    deletion.status === "completed" ||
    deletion.status === "cancelled"
  ) {
    return null
  }
  return {
    deletedOnRelay: deletion.relayDeletedAt !== null,
    deletionStarted:
      deletion.relayDeletingAt !== null || deletion.relayDeletedAt !== null,
    error: deletion.status === "failed" ? deletion.error : null,
    finalBackup: deletion.finalBackup,
    status: deletion.status,
  } satisfies ResourceDeletionSummary
}

export async function getResourceDeletionHandler(
  target: ResourceDeletionTarget
): Promise<ResourceDeletionSummary | null> {
  await authorize(target, [permissionFor(target, "read")])
  return summarize(
    await findResourceDeletion(target.relayId, target.kind, target.resourceId)
  )
}

/**
 * The deletions of a Relay's Kiln volumes that are running or stopped, by
 * volume, for its volumes list: volumes have no page of their own.
 */
export async function listVolumeDeletionsHandler(input: {
  relayId: string
}): Promise<Array<{ summary: ResourceDeletionSummary; volumeId: string }>> {
  await authorize({ kind: "volume", relayId: input.relayId, resourceId: "" }, [
    "relay.read",
  ])
  const deletions = await runAppEffect(
    "resourceDeletions.listVolumes",
    listResourceDeletionsOfKindEffect(input.relayId, "volume")
  )
  return deletions.flatMap((deletion) => {
    const summary = summarize(deletion)
    return summary ? [{ summary, volumeId: deletion.resourceId }] : []
  })
}

/**
 * Tries a deletion that stopped again, with its final backup or without
 * one. Dropping a final backup it was asked to take changes what was
 * confirmed, so it asks the deletion confirmation again. Once its Relay was
 * asked to delete it, it's finished as it was asked, with no new final
 * backup, and nothing more is asked.
 */
export async function retryResourceDeletionHandler(
  input: ResourceDeletionTarget & {
    confirmation?: string
    finalBackup: boolean
    password?: string
  }
): Promise<void> {
  const user = await authorize(input, [permissionFor(input, "delete")])
  const deletion = await findResourceDeletion(
    input.relayId,
    input.kind,
    input.resourceId
  )
  if (!deletion || deletion.status !== "failed") {
    throw new Error("Only a deletion that stopped can be tried again")
  }
  const started =
    deletion.relayDeletingAt !== null || deletion.relayDeletedAt !== null
  const finalBackup = input.finalBackup && !started
  if (finalBackup) await requireFinalBackupPermission(input, user)
  if (!finalBackup && deletion.finalBackup && !started) {
    await requireDeleteConfirmation({
      confirmation: input.confirmation ?? "",
      name: await resourceName(input),
      password: input.password ?? "",
      user,
    })
  }
  // Only from the attempt read above: one kept or retried meanwhile, while
  // this request was checking, is refused.
  await requestResourceDeletion({
    finalBackup,
    kind: input.kind,
    relayId: input.relayId,
    resourceId: input.resourceId,
    retryOf: deletion.attempt,
    user,
    ...(finalBackup ? { storageId: deletion.storageId } : {}),
  })
}

/** Keeps a resource whose deletion stopped before the Relay deleted it. */
export async function cancelResourceDeletionHandler(
  target: ResourceDeletionTarget
): Promise<void> {
  const user = await authorize(target, [permissionFor(target, "delete")])
  await cancelResourceDeletion({ ...target, user })
}

// The name its pages show, which its deletion confirmation asks for.
async function resourceName(target: ResourceDeletionTarget): Promise<string> {
  if (target.kind === "instance") {
    return instanceDeletionName(
      await activeRelay(target.relayId),
      target.resourceId
    )
  }
  if (target.kind === "volume") {
    const { volumes } = relayVolumesSchema.parse(
      await relayRpc(
        await activeRelay(target.relayId),
        "relay.volumes.read",
        {},
        30_000
      )
    )
    return (
      volumes.find((volume) => volume.id === target.resourceId)?.name ??
      target.resourceId
    )
  }
  if (target.kind === "app") {
    const app = (
      await runAppEffect("apps.deletionName", listAppRecordsEffect())
    ).find(
      (candidate) =>
        candidate.relayId === target.relayId &&
        candidate.appId === target.resourceId
    )
    return app?.name ?? target.resourceId
  }
  const record = (
    await runAppEffect(
      "managedDatabases.deletionName",
      listManagedDatabaseRecordsEffect()
    )
  ).find(
    (candidate) =>
      candidate.relayId === target.relayId &&
      candidate.databaseId === target.resourceId
  )
  return record?.name ?? target.resourceId
}
