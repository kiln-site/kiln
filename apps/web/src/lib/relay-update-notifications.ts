import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import { compareKilnReleaseVersions } from "@workspace/contracts"

import { Database } from "@/effect/database"
import {
  publishNotificationChange,
  replaceNotificationEffect,
} from "@/effect/notifications"
import { databaseTable } from "@/lib/database-config"
import {
  kilnReleaseTagUrl,
  mergeKilnUpdates,
} from "@/lib/kiln-update-notifications"
import { isKilnReleaseVersion } from "@/lib/release-version"
import { notificationAudienceEffect } from "@/lib/resource-audience.server"
import { exclusive, partKey, relayKey } from "@/operations/lanes"
import { operation, runOperation } from "@/operations/operation"

/**
 * Records the version a Relay connected with and, when it's newer than the
 * one recorded, tells those who can update the Relay, as part of the one Kiln
 * update notification each person has. Reconnecting on the same version does
 * nothing, and the first version seen is only recorded. They commit together,
 * so an update is told once.
 */
export const recordRelayVersionEffect = Effect.fn(
  "notifications.recordRelayVersion"
)(function* (relayId: string, version: string) {
  const database = yield* Database
  const table = databaseTable("relay")
  const notified = yield* database.transaction(
    "notifications.recordRelayVersion",
    (tx) =>
      Effect.gen(function* () {
        const [row] = yield* tx.queryRows<
          RowDataPacket & { name: string; node_version: string | null }
        >(`SELECT name, node_version FROM ${table} WHERE id = ? FOR UPDATE`, [
          relayId,
        ])
        if (!row || row.node_version === version) return []
        yield* tx.execute(`UPDATE ${table} SET node_version = ? WHERE id = ?`, [
          version,
          relayId,
        ])
        const previous = row.node_version
        if (
          previous === null ||
          !isKilnReleaseVersion(previous) ||
          !isKilnReleaseVersion(version) ||
          compareKilnReleaseVersions(version, previous) !== 1
        )
          return []
        const relay = {
          id: relayId,
          name: row.name,
          relayId,
          type: "relay",
        } as const
        const recipients = yield* notificationAudienceEffect(
          { relayId, resourceId: relayId, resourceType: "relay" },
          "relay.update",
          "kiln.updated"
        )
        for (const userId of new Set(recipients))
          yield* replaceNotificationEffect(
            userId,
            "kiln.updated",
            (unread) =>
              mergeKilnUpdates(unread, {
                hearth: false,
                kind: "kiln.updated",
                previousVersion: previous,
                relays: [relay],
                url: kilnReleaseTagUrl(version),
                version,
              }),
            { sourceKey: `relay.updated:${relayId}:${version}` }
          )
        return recipients
      })
  )
  publishNotificationChange(notified)
})

const recordConnectedRelayVersion = operation<string>()({
  name: "relay.version.record",
  doing: "Recording this Relay's version",
  locks: ({ input }) => [exclusive(partKey(relayKey(input), "version"))],
  // Read once it's this one's turn, so what an earlier try or a dropped
  // connection saw can't overwrite what the Relay says now.
  run: ({ input: relayId }) =>
    Effect.gen(function* () {
      const { relayConnectionNode } = yield* Effect.promise(
        () => import("@/lib/relay-connection")
      )
      const version = relayConnectionNode(relayId)?.version ?? null
      if (version !== null) yield* recordRelayVersionEffect(relayId, version)
      return version
    }),
})

/** Records the version a Relay is connected with. Answers what it recorded. */
export const recordConnectedRelayVersionEffect = (relayId: string) =>
  runOperation(recordConnectedRelayVersion, relayId, { user: null })
