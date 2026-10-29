import type { AccessPermission } from "@workspace/contracts"

import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  cancelResourceDeletion,
  findResourceDeletion,
  requestResourceDeletion,
} from "@/lib/resource-deletion.server"
import { requireEligibleResourceUser } from "@/server/auth"

export interface ResourceDeletionTarget {
  kind: "database" | "instance"
  relayId: string
  resourceId: string
}

/** What a resource's page shows of its deletion, while it's running or stopped. */
export interface ResourceDeletionSummary {
  /** Whether it stopped after the Relay deleted it, so only cleanup is left. */
  deletedOnRelay: boolean
  error: string | null
  finalBackup: boolean
  status: "backing_up" | "cancelling" | "deleting" | "failed" | "pending"
}

function permissionFor(
  target: ResourceDeletionTarget,
  action: "delete" | "read"
): AccessPermission {
  return target.kind === "instance"
    ? `instance.${action}`
    : `database.${action}`
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
        : { databaseId: target.resourceId }),
    })
  }
  return user
}

export async function getResourceDeletionHandler(
  target: ResourceDeletionTarget
): Promise<ResourceDeletionSummary | null> {
  await authorize(target, [permissionFor(target, "read")])
  const deletion = await findResourceDeletion(
    target.relayId,
    target.kind,
    target.resourceId
  )
  if (
    !deletion ||
    deletion.status === "completed" ||
    deletion.status === "cancelled"
  ) {
    return null
  }
  return {
    deletedOnRelay: deletion.relayDeletedAt !== null,
    error: deletion.status === "failed" ? deletion.error : null,
    finalBackup: deletion.finalBackup,
    status: deletion.status,
  }
}

/**
 * Tries a deletion that stopped again, with its final backup or without
 * one. Deleting a game server without one asks for the account password, as
 * deleting it does; once the Relay has deleted it, only its cleanup is
 * left, and nothing more is asked.
 */
export async function retryResourceDeletionHandler(
  input: ResourceDeletionTarget & { finalBackup: boolean; password?: string }
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
  const finalBackup = input.finalBackup && deletion.relayDeletedAt === null
  if (finalBackup) await authorize(input, ["backup.create"])
  if (
    input.kind === "instance" &&
    !finalBackup &&
    deletion.finalBackup &&
    deletion.relayDeletedAt === null
  ) {
    const { requireAccountPassword } = await import("@/lib/auth-password")
    await requireAccountPassword(user, input.password ?? "")
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
