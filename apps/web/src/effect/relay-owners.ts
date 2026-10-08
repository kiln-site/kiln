import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"
import { DISPLAY_NAME_MAX_LENGTH, resolveDisplayName } from "@/lib/display-name"

interface RelayOwnerRow extends RowDataPacket {
  email: string
  id: string
  name: string | null
}

export interface RelayOwnerFields {
  ownerEmail: string | null
  ownerName: string | null
}

const unnamedOwner = "Unnamed user"

/**
 * Attach each Relay creator's identity. Like Brick catalogs, owner emails are
 * only for platform administrators; others never see email-derived names.
 */
export const attachRelayOwnersEffect = Effect.fn("relays.owners.attach")(
  function* <TRelay extends { createdBy: string | null }>(
    relays: ReadonlyArray<TRelay>,
    includeOwnerDetails: boolean
  ) {
    const ownerIds = [
      ...new Set(
        relays.flatMap((relay) => (relay.createdBy ? [relay.createdBy] : []))
      ),
    ]
    const database = yield* Database
    const owners =
      ownerIds.length === 0
        ? []
        : yield* database.queryRows<RelayOwnerRow>(
            "relays.owners.list",
            `SELECT id, name, email FROM ${databaseTable("user")}
              WHERE id IN (${ownerIds.map(() => "?").join(", ")})`,
            ownerIds
          )
    const ownersById = new Map(owners.map((owner) => [owner.id, owner]))
    return relays.map((relay): TRelay & RelayOwnerFields => {
      const owner = relay.createdBy
        ? ownersById.get(relay.createdBy)
        : undefined
      return {
        ...relay,
        ownerEmail: owner && includeOwnerDetails ? owner.email : null,
        ownerName: owner ? ownerDisplayName(owner, includeOwnerDetails) : null,
      }
    })
  }
)

function ownerDisplayName(
  owner: RelayOwnerRow,
  includeOwnerDetails: boolean
): string {
  if (includeOwnerDetails) return resolveDisplayName(owner.name, owner.email)
  const name = owner.name?.trim()
  return name ? name.slice(0, DISPLAY_NAME_MAX_LENGTH) : unnamedOwner
}
