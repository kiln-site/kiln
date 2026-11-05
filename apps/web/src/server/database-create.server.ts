import { randomBytes, randomUUID } from "node:crypto"

import {
  databaseEngineHasNamedDatabase,
  databaseNameIssue,
  databaseUsernameIssue,
  relayManagedDatabaseSchema,
} from "@workspace/contracts"
import type { DatabaseEngine } from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import {
  createManagedDatabaseRecordEffect,
  deleteManagedDatabaseRecordEffect,
  managedDatabaseNameExistsEffect,
} from "@/effect/managed-databases"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  abandonPreparedProvisioning,
  claimPreparedProvisioning,
} from "@/lib/provisioning.server"
import { exclusive, relayKey, resourceKey, shared } from "@/operations/lanes"
import { operation, signedIn } from "@/operations/operation"
import {
  databaseRpc,
  publishDatabaseChange,
  requiredRelay,
} from "@/server/managed-database-access"

export interface CreateDatabaseInput {
  /** Generated when left out. Ignored by an engine with no named databases. */
  databaseName?: string
  engine: DatabaseEngine
  /** Settled by the operation creating it with something else. */
  id?: string
  name: string
  relayId: string
  /** Generated when left out. */
  username?: string
}

const cancelledSchema = z.object({ cancelled: z.boolean() })

// Holds the database it creates, by the ID it settles first, and its Relay
// shared, so the Relay isn't removed meanwhile. The Relay is read once
// admitted, so one removed since can't gain the database.
export const createDatabase = operation<CreateDatabaseInput>()({
  name: "database.create",
  doing: "Creating this database",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        promiseEffect(() =>
          requireRelayPermission({
            permission: "database.create",
            relayId: input.relayId,
            user: person,
          })
        )
      ),
      Effect.map((person) => ({
        id: input.id ?? randomBytes(20).toString("hex"),
        user: person,
      }))
    ),
  locks: ({ context, input }) => [
    exclusive(resourceKey("database", input.relayId, context.id)),
    shared(relayKey(input.relayId)),
  ],
  run: ({ context, input }) =>
    promiseEffect(() => createDatabaseHandler(context.user, input, context.id)),
  audit: ({ context, input }) => ({
    id: context.id,
    kind: "database",
    relayId: input.relayId,
  }),
})

async function createDatabaseHandler(
  user: AuthenticatedUser,
  data: CreateDatabaseInput,
  id: string
) {
  const relay = await requiredRelay(data.relayId)
  const nameExists = await runAppEffect(
    "managedDatabases.name.preflight",
    managedDatabaseNameExistsEffect(relay.id, data.name)
  )
  if (nameExists) {
    throw new Error(
      `A database named "${data.name}" already exists on ${relay.name}`
    )
  }
  const username = data.username ?? `kiln_${randomBytes(6).toString("hex")}`
  const password = randomBytes(36).toString("base64url")
  const databaseName =
    (databaseEngineHasNamedDatabase(data.engine) ? data.databaseName : null) ??
    `kiln_${id.slice(0, 12)}`
  const issue =
    databaseNameIssue(data.engine, databaseName) ??
    databaseUsernameIssue(data.engine, username)
  if (issue) throw new Error(issue)
  // The Relay creates it in the background; it opens on its provisioning
  // page at once.
  const cancel = () =>
    databaseRpc(
      relay,
      "database.provision.cancel",
      { databaseId: id },
      30_000,
      user.id
    ).then((result) => cancelledSchema.parse(result).cancelled)
  const unregister = () =>
    runAppEffect(
      "managedDatabases.record.delete",
      deleteManagedDatabaseRecordEffect(relay.id, id)
    )
  // Recorded first, so a job the Relay holds always has a database in
  // Hearth to show it and delete it from.
  await runAppEffect(
    "managedDatabases.record.create",
    createManagedDatabaseRecordEffect({
      createdBy: user.id,
      databaseId: id,
      databaseName,
      engine: data.engine,
      name: data.name,
      password,
      relayId: relay.id,
      username,
    })
  )
  const placeholder = await Effect.runPromise(
    promiseEffect(() =>
      databaseRpc(
        relay,
        "database.provision.prepare",
        {
          databaseName,
          engine: data.engine,
          id,
          idempotencyKey: randomUUID(),
          name: data.name,
          password,
          username,
        },
        30_000,
        user.id
      )
    ).pipe(
      Effect.map((value) => relayManagedDatabaseSchema.parse(value)),
      Effect.tapError(() => abandonPreparedProvisioning(cancel, unregister))
    )
  )
  await claimPreparedProvisioning({
    cancel,
    claim: () =>
      databaseRpc(
        relay,
        "database.provision.claim",
        { databaseId: id },
        30_000,
        user.id
      ),
    unconfirmed: "If it stays waiting, delete it and create it again.",
    unregister,
  })
  publishDatabaseChange(relay.id, true)
  return { ...placeholder, relayId: relay.id, relayName: relay.name }
}
