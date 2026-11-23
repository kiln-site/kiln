import { Effect, Schema } from "effect"
import * as SecureStore from "expo-secure-store"

import type { HearthSession } from "../api/hearth"

// One Hearth for the prototype. A list of Hearths can replace this key later.
const SESSION_KEY = "kiln.session.v1"

const StoredSession = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  credential: Schema.Struct({
    id: Schema.String,
    mode: Schema.Literals(["full_access", "read_only"]),
    name: Schema.String,
    expiresAt: Schema.NullOr(Schema.String),
  }),
})

const decodeStoredSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredSession)
)

export const loadSession = Effect.fn("Session.load")(function* () {
  const raw = yield* Effect.tryPromise(() =>
    SecureStore.getItemAsync(SESSION_KEY)
  )
  if (raw === null) return null
  const session: HearthSession = yield* decodeStoredSession(raw)
  return session
})

export const saveSession = Effect.fn("Session.save")(function* (
  session: HearthSession
) {
  yield* Effect.tryPromise(() =>
    SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    })
  )
})

export const clearSession = Effect.fn("Session.clear")(function* () {
  yield* Effect.tryPromise(() => SecureStore.deleteItemAsync(SESSION_KEY))
})
