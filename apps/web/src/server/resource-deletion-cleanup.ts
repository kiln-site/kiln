import { Effect } from "effect"

import { setInstanceDomainOptOutEffect } from "@/effect/domains"
import { deleteResourceGitHubSyncsEffect } from "@/effect/github-sync"
import { removeIconsEffect } from "@/effect/icons"
import { removeResourceFavoritesEffect } from "@/effect/instance-favorites"
import { deleteAppRecordEffect } from "@/effect/managed-apps"
import { deleteManagedDatabaseRecordEffect } from "@/effect/managed-databases"
import {
  publishNotificationChange,
  resolveMigrationSourceNotificationsEffect,
} from "@/effect/notifications"
import { promiseEffect } from "@/effect/promise"
import { reportAppError } from "@/effect/runtime"
import { deleteResourceAccessEffect } from "@/lib/access-control"
import { removeDeletedInstanceEffect } from "@/lib/instance-registry"
import { invalidateRelayCache, relayCachePolicy } from "@/lib/relay-client"
import { deleteInstanceDomainEffect } from "@/server/domains.server"

/** A game server, App, or database the Relay no longer has. */
export interface DeletedResource {
  id: string
  kind: "app" | "database" | "instance"
  relayId: string
}

/**
 * Removes everything in Hearth that points at a resource the Relay has
 * deleted, the same way for every kind, as system work whoever asked. Run
 * only once the Relay no longer has it, and safe to run again. Its backups
 * stay; they go only as backups are deleted.
 *
 * Every step that records something must succeed: one that fails fails the
 * cleanup with the resource's record still there, for the deletion to run it
 * again. What's sent elsewhere is owed, not awaited: DNS records the worker
 * finishes, schedules the Relays are sent again. The record goes last.
 */
export const cleanUpDeletedResourceEffect = Effect.fn(
  "resources.delete.cleanUp"
)(function* (resource: DeletedResource, subject: string) {
  const { id, kind, relayId } = resource
  if (kind === "instance") {
    // Only once the server is gone: its names stay held while it might
    // survive. Deletes Cloudflare refuses are left to the DNS worker.
    yield* deleteInstanceDomainEffect(relayId, id)
  }
  if (kind !== "database") {
    yield* promiseEffect(async () => {
      const { deleteResourceWebHostnamesBestEffort } =
        await import("@/server/web-hostname-access.server")
      await deleteResourceWebHostnamesBestEffort({
        relayId,
        resourceId: id,
        resourceType: kind,
      })
    })
  }
  if (kind === "instance") {
    yield* cleanupStep(
      "relay.snapshot.invalidate",
      resource,
      invalidateRelayCache(relayCachePolicy.snapshot(relayId))
    )
    // A removed vanity domain stays removed until the server itself is gone.
    yield* setInstanceDomainOptOutEffect(relayId, id, false)
    // A finished move stops offering to delete the server it left.
    yield* resolveMigrationSourceNotificationsEffect(relayId, id).pipe(
      Effect.tap((userIds) =>
        Effect.sync(() => publishNotificationChange(userIds))
      )
    )
  }
  if (kind !== "app") {
    // Apps can't be shared, so they have no grants, and schedules don't
    // target them yet.
    yield* deleteResourceAccessEffect(relayId, kind, id)
    yield* promiseEffect(async () => {
      const { removeDeletedResourceFromSchedules } =
        await import("@/server/schedules")
      await removeDeletedResourceFromSchedules({ id, kind, relayId }, subject)
    })
  }
  if (kind !== "database") {
    yield* deleteResourceGitHubSyncsEffect(relayId, kind, id)
  }
  yield* removeResourceFavoritesEffect({
    id,
    kind: kind === "instance" ? "server" : kind,
    relayId,
  })
  yield* removeIconsEffect({ kind: kind === "instance" ? "server" : kind, relayId, id })
  // The Relay has removed it, so its directory record goes too. Live
  // snapshots never remove records on their own.
  yield* kind === "instance"
    ? removeDeletedInstanceEffect(relayId, id)
    : kind === "app"
      ? deleteAppRecordEffect(relayId, id)
      : deleteManagedDatabaseRecordEffect(relayId, id)
})

// The one step only worth reporting: a stale cache refreshes on its own.
function cleanupStep<TError, TRequirements>(
  operation: string,
  resource: DeletedResource,
  cleanup: Effect.Effect<unknown, TError, TRequirements>
) {
  return cleanup.pipe(
    Effect.asVoid,
    Effect.catch((error) => reportCleanupFailureEffect(operation, resource, error))
  )
}

const reportCleanupFailureEffect = Effect.fn(
  "resources.delete.reportCleanupFailure"
)(function* (operation: string, resource: DeletedResource, error: unknown) {
  yield* Effect.sync(() =>
    reportAppError(error, {
      operation,
      attributes: {
        "kiln.relay_id": resource.relayId,
        "kiln.resource.id": resource.id,
        "kiln.resource.kind": resource.kind,
      },
    })
  )
  yield* Effect.logWarning(
    "Hearth cleanup failed after the Relay deleted a resource",
    {
      error: error instanceof Error ? error.message : String(error),
      operation,
      resource,
    }
  )
})
