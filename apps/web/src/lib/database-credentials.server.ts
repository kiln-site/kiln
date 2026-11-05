import { Effect, Result, Schema } from "effect"
import { Activity } from "effect/workflow"

import type { Database } from "@/effect/database"
import {
  decryptManagedDatabasePassword,
  encryptManagedDatabasePassword,
  loadManagedDatabaseCredentialEffect,
  rotateManagedDatabaseCredentialEffect,
} from "@/effect/managed-databases"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import {
  durableOperation,
  startDurableOperation,
  whileMySqlIsAway,
} from "@/operations/durable"
import { exclusive, partKey, resourceKey } from "@/operations/lanes"
import { awaitOperationEnd, loadOperation } from "@/operations/records"
import { RelayCommandError, relayCommand } from "@/operations/relay-command"

const ChangeInput = Schema.Struct({
  // Who asked, for the audit of what's sent to the Relay.
  actorId: Schema.String,
  databaseId: Schema.String,
  // The new password, encrypted as the database's own, since this is kept
  // until it ends and for a while after. Left out, the password stays.
  passwordCiphertext: Schema.optionalKey(Schema.String),
  relayId: Schema.String,
  // Left out, the username stays.
  username: Schema.optionalKey(Schema.String),
})

const asCommandError = (error: unknown) =>
  error instanceof RelayCommandError
    ? error
    : new RelayCommandError({
        code: "unexpected",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      })

// What Hearth has for the database and what it's changing to. It keeps the
// old login until the Relay has finished, so this reads the same each time,
// and again once saved, when the two are the same.
const logins = (input: typeof ChangeInput.Type) =>
  Effect.gen(function* () {
    const credential = yield* loadManagedDatabaseCredentialEffect(
      input.relayId,
      input.databaseId
    )
    if (!credential) {
      return yield* new RelayCommandError({
        code: "database_missing",
        message: "Database credentials are unavailable",
        retryable: false,
      })
    }
    const password =
      input.passwordCiphertext === undefined
        ? credential.password
        : (yield* decryptManagedDatabasePassword(input.passwordCiphertext))
            .plaintext
    return {
      current: { password: credential.password, username: credential.username },
      next: { password, username: input.username ?? credential.username },
    }
  })

// A Relay that stopped partway through leaves the login half changed, and
// it finishes the same change when sent it again.
const MAX_RESENDS = 3

/**
 * Changes a database's username, password or both, and keeps the result. It
 * has to survive a restart: a Relay that changed the login while Hearth still
 * had the old one would leave Hearth locked out of the database. It holds the
 * database's credentials, so another change, or anything that sends the
 * password, waits for it; a wipe holds the whole database.
 */
export const changeDatabaseLogin = durableOperation({
  doing: () => "Changing this database's credentials",
  error: RelayCommandError,
  input: ChangeInput,
  kind: "database.login.change",
  locks: ({ databaseId, relayId }) => [
    exclusive(
      partKey(resourceKey("database", relayId, databaseId), "credentials")
    ),
  ],
  run: (input) =>
    Effect.gen(function* () {
      for (let resend = 0; ; resend++) {
        const sent = yield* relayCommand({
          name: resend === 0 ? "apply" : `apply again ${resend}`,
          operation: "database.credentials.rotate",
          // Sent as read below, so no password is kept with the step.
          payload: { databaseId: input.databaseId },
          recover: Effect.succeed(null),
          relayId: input.relayId,
          sendPayload: logins(input).pipe(
            Effect.map(({ current, next }) => ({
              currentPassword: current.password,
              databaseId: input.databaseId,
              nextPassword: next.password,
              nextUsername: next.username,
              username: current.username,
            })),
            Effect.mapError(asCommandError)
          ),
          subject: input.actorId,
          // A rename can replace the container, as a limit change can.
          timeoutMs: 240_000,
        }).pipe(Effect.result)
        if (Result.isSuccess(sent)) break
        if (sent.failure.code !== "interrupted" || resend >= MAX_RESENDS) {
          return yield* sent.failure
        }
      }
      yield* Activity.make({
        name: "save",
        error: RelayCommandError,
        execute: logins(input).pipe(
          Effect.flatMap(({ next }) =>
            rotateManagedDatabaseCredentialEffect(
              input.relayId,
              input.databaseId,
              next
            )
          ),
          Effect.retry({
            schedule: whileMySqlIsAway,
            while: (error) =>
              typeof error === "object" &&
              "_tag" in error &&
              error._tag === "DatabaseError",
          }),
          Effect.mapError(asCommandError)
        ),
      })
      publishRealtimeChange({
        audience: { kind: "relays", relayIds: [input.relayId] },
        scope: { databaseId: input.databaseId, relayId: input.relayId },
        topics: ["database-credentials"],
        type: "hearth.invalidate",
      })
    }),
  version: 1,
})

// As long as a person waits to hear how a change went. It finishes without
// them, however long its Relay takes to answer.
const WAIT = "270 seconds"

/**
 * Starts a change to a database's login for someone, keeping the new password
 * encrypted with it, and waits to tell them how it went. What's left out stays
 * as it is.
 */
export const changeDatabaseLoginAndWait = <AuthorizeError>(
  change: {
    readonly databaseId: string
    readonly password?: string
    readonly relayId: string
    readonly username?: string
  },
  options: {
    readonly actorId: string
    readonly authorize: Effect.Effect<void, AuthorizeError, Database>
  }
) =>
  Effect.gen(function* () {
    const id = yield* startDurableOperation(
      changeDatabaseLogin,
      {
        actorId: options.actorId,
        databaseId: change.databaseId,
        relayId: change.relayId,
        ...(change.username !== undefined && { username: change.username }),
        ...(change.password !== undefined && {
          passwordCiphertext: yield* encryptManagedDatabasePassword(
            change.password
          ),
        }),
      },
      options
    )
    yield* awaitOperationEnd(id).pipe(Effect.timeoutOption(WAIT))
    const ended = yield* loadOperation(id)
    if (ended?.state === "succeeded") return { changed: true }
    return yield* Effect.fail(
      new Error(
        ended?.state === "running"
          ? "This change is still waiting for the Relay, and will finish once it answers"
          : (ended?.error ?? "The credentials couldn't be changed")
      )
    )
  })
