import { relaySnapshotSchema } from "@workspace/contracts"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { Database } from "@/effect/database"
import { AuthenticationError } from "@/effect/errors"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { requireAccountPasswordEffect } from "@/lib/auth-password"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"
import {
  confirmationMatches,
  type DeleteConfirmation,
} from "@/lib/delete-confirmation"
import { relayRpc } from "@/lib/relay-connection"
import type { PersistedRelay } from "@/lib/relay-registry"

/**
 * The one check every deletion of a game server, database, App, or volume
 * makes before it starts, from the browser or the CLI: the name typed is the
 * resource's, and the password is the account's. The name goes first, so a
 * mistyped one never costs a password attempt.
 */
export const requireDeleteConfirmationEffect = Effect.fn("deletion.confirm")(
  function* (
    input: DeleteConfirmation & { name: string; user: AuthenticatedUser }
  ) {
    if (!confirmationMatches(input.confirmation, input.name)) {
      return yield* AuthenticationError.make({
        message: `Type ${input.name.trim()} exactly to confirm.`,
      })
    }
    yield* requireAccountPasswordEffect(input.user, input.password)
  }
)

export function requireDeleteConfirmation(
  input: Parameters<typeof requireDeleteConfirmationEffect>[0]
): Promise<void> {
  return runAppEffect(
    "deletion.confirm",
    requireDeleteConfirmationEffect(input)
  )
}

/**
 * A game server's name as its pages show it: the Relay's, or, when the
 * Relay no longer lists it, as after a deletion that stopped partway, the
 * last one Hearth saw.
 */
export const instanceDeletionNameEffect = Effect.fn("deletion.instanceName")(
  function* (relay: PersistedRelay, instanceId: string) {
    const snapshot = yield* promiseEffect(() =>
      relayRpc(relay, "relay.snapshot", {}, 15_000)
    ).pipe(Effect.map((value) => relaySnapshotSchema.parse(value)))
    const listed = snapshot.instances.find(
      (instance) => instance.id === instanceId
    )
    if (listed) return listed.name
    const database = yield* Database
    const [row] = yield* database.queryRows<
      RowDataPacket & {
        display_name: string | null
        source_name: string | null
      }
    >(
      "deletion.instanceName",
      `SELECT display_name, source_name FROM ${databaseTable("instance")}
        WHERE relay_id = ? AND instance_id = ? LIMIT 1`,
      [relay.id, instanceId]
    )
    return row?.source_name ?? row?.display_name ?? instanceId
  }
)

export function instanceDeletionName(
  relay: PersistedRelay,
  instanceId: string
): Promise<string> {
  return runAppEffect(
    "deletion.instanceName",
    instanceDeletionNameEffect(relay, instanceId)
  )
}
