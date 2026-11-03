import { createServerFn } from "@tanstack/react-start"
import {
  relayDockerCleanupRequestSchema,
  relayDockerCleanupStartSchema,
  relayDockerStorageSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import { promiseEffect } from "@/effect/promise"
import { requireRelayPermission } from "@/lib/access-control"
import { exclusive, partKey, relayKey } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import { databaseRpc, requiredRelay } from "@/server/managed-database-access"
import { authorizedRelay } from "@/server/relay-access"

const targetSchema = z.object({ relayId: relayIdSchema })
const cleanupSchema = targetSchema.extend(relayDockerCleanupRequestSchema.shape)

// What Docker holds on a Relay's host, and what a cleanup could remove of
// it. Docker counts every image's layers to answer, so it can take a while.
export const getRelayDockerStorage = createServerFn({ method: "GET" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const { relay } = await authorizedRelay(data.relayId, "relay.read")
    return relayDockerStorageSchema.parse(
      await databaseRpc(relay, "relay.docker.storage", {}, 90_000)
    )
  })

// Starts a cleanup on the Relay that removes what its hourly passes would,
// without waiting a day for images no Kiln container uses, and what the
// person chose besides. It runs in the background; the storage figures
// show it until it's done, and the Relay runs one at a time.
const cleanUpRelayDockerOperation = operation<z.infer<typeof cleanupSchema>>()({
  name: "relay.docker.cleanup",
  doing: "Cleaning up this Relay's Docker",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.flatMap((person) =>
        promiseEffect(async () => {
          await requireRelayPermission({
            permission: "relay.configure",
            relayId: input.relayId,
            user: person,
          })
          return { relay: await requiredRelay(input.relayId), user: person }
        })
      )
    ),
  locks: ({ input }) => [
    exclusive(partKey(relayKey(input.relayId), "docker-cleanup")),
  ],
  run: ({ context: { relay, user }, input }) =>
    promiseEffect(async () =>
      relayDockerCleanupStartSchema.parse(
        await databaseRpc(
          relay,
          "relay.docker.cleanup",
          {
            buildCache: input.buildCache,
            unknownImages: input.unknownImages,
          },
          30_000,
          user.id
        )
      )
    ),
  audit: ({ input }) => ({
    id: input.relayId,
    kind: "relay",
    relayId: input.relayId,
  }),
})

export const cleanUpRelayDocker = createServerFn({ method: "POST" })
  .validator(cleanupSchema)
  .handler(async ({ data }) =>
    runOperationPromise(cleanUpRelayDockerOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )
