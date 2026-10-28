import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
} from "node:crypto"
import { lookup as dnsLookup } from "node:dns"
import { BlockList, isIP, type LookupFunction } from "node:net"
import { connect as tlsConnect, type TLSSocket } from "node:tls"

import {
  isKilnNightlyVersion,
  RELAY_JOIN_ID_LABEL,
  RELAY_JOIN_INVITATION_LABEL,
  RELAY_JOIN_HOLD_MAX_MS,
  RELAY_JOIN_LIFETIME_MS,
  relayControlDialV1Feature,
  relayJoinHeldHeader,
  relayJoinHoldHeader,
  relayJoinSavedHeader,
  relayJoinPairingV1Feature,
  type RelayJoinEnvelope,
  RelayJoinAnnouncementSchema,
  type RelayJoinStatus,
  RelayOperationLookupSchema,
  relayInstallationSchema,
  relayJoinAnnouncementTranscript,
  relayJoinResponseTranscript,
  relayPairingRequestTranscript,
  relayProxySettingsSchema,
  type RelayPairingRequestContract,
  type RelayPairingResponseContract,
} from "@workspace/contracts"
import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Result,
  Schedule,
  Schema,
} from "effect"
import type { Tracer } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { z } from "zod"

import { Database } from "@/effect/database"
import { loadedKilnInstallationId } from "@/effect/installation"
import { promiseEffect } from "@/effect/promise"
import { forkAppWorker } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import { kilnInstallScriptUrl, kilnPublicUrl } from "@/lib/environment"
import { hearthDialUrl, relayPairingOrigin } from "@/lib/relay-control-endpoint"
import { relayNameForNewPairing } from "@/lib/relay-names"
import {
  mapPairingTransportError,
  unreachablePairingError,
  unreachableRelayError,
} from "@/lib/relay-pairing-errors"
import {
  decryptPrivateKey,
  encryptPrivateKey,
  findPersistedRelayRow,
  inspectPersistedRelay,
  listPersistedRelays,
  pairingResponseSchema,
  persistPairedRelayEffect,
  postPairingRequest,
  publicKeyFingerprint,
  publishRelayCollectionChange,
  verifyPairingResponse,
  type PersistedRelay,
} from "@/lib/relay-registry"
import { readLimitedText } from "@/lib/request-body"
import { assertRequestRateLimit } from "@/lib/request-rate-limit"

// Joins: adding a Relay from the install command in the Add Relay dialog.
//
// Opening the dialog makes (or reopens) the person's join: a secret and a
// Hearth client key, which the command carries to the new Relay as a join
// link (packages/contracts relay-join.ts). The Relay announces itself here
// (`/api/relays/join`); the first announcement a join accepts is the only
// one it ever will. Someone then confirms it with a name and a choice about
// the Relay's installation ID, which freezes that intent, and a worker
// carries it out step by step, each recorded, so a Hearth that restarts or
// a confirmation that fails partway picks up where it stopped:
//
//   pairing    pair with the Relay using the join's key
//   saved      the Relay is saved, its credentials with it
//   connected  Hearth reached it, and read its installation ID
//   installation  replacing that ID, by an operation ID kept for asking
//                 how it went
//
// Only one worker acts on a join at a time: each claim increments
// `claim_generation`, every write checks it, and a claim whose lease ran out
// can be taken over.

const LEASE_MS = 2 * 60_000
const LEASE_RENEW_MS = 30_000
// A finished join keeps its secret this long, to tell its Relay how it went.
const TERMINAL_RETENTION_MS = 24 * 60 * 60_000
const ANNOUNCEMENT_BYTES = 16 * 1024
// How the worker keeps trying to reach a Relay it just saved: soon at
// first, since a try can fail as the Relay's own connection takes its place,
// then at most every 2 s, for a minute. A Relay that dials Hearth usually
// arrives during a try; one older than waking its dialer arrives within its
// next pass, up to 17 s later.
const connectSchedule = Schedule.min([
  Schedule.exponential("250 millis"),
  Schedule.spaced("2 seconds"),
]).pipe(Schedule.upTo({ duration: "1 minute" }))
// How often the worker, and an announcement Hearth holds, look at a join
// again when nothing in this process said it changed: the change may come
// from another Hearth process.
const REPLY_POLL_MS = 1_000
const HOLD_RECHECK_MS = 500

// Wakes whatever in this process waits on a join once a change to it is
// committed: the worker waiting for the Relay's reply, and announcements
// Hearth holds. Only a shortcut: they also look again on their own, since
// the change can come from another process.
const joinListeners = new Map<string, Set<() => void>>()

function joinChanged(joinId: string): void {
  for (const listener of joinListeners.get(joinId) ?? []) listener()
}

// Watches for a change to the join in this process for as long as the scope
// lasts. Taken before the caller looks at the join, so a change that lands
// while it looks still counts: the wait it gives ends at once then, and
// otherwise at the next change or after `ms`.
const watchJoin = (joinId: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const changed = Deferred.makeUnsafe<void>()
      const listener = () => {
        Deferred.doneUnsafe(changed, Exit.void)
      }
      const listeners = joinListeners.get(joinId) ?? new Set<() => void>()
      joinListeners.set(joinId, listeners)
      listeners.add(listener)
      return { changed, listener }
    }),
    ({ listener }) =>
      Effect.sync(() => {
        const listeners = joinListeners.get(joinId)
        listeners?.delete(listener)
        if (listeners?.size === 0) joinListeners.delete(joinId)
      })
  ).pipe(
    Effect.map(
      ({ changed }) =>
        (ms: number) =>
          Effect.raceFirst(Deferred.await(changed), Effect.sleep(ms))
    )
  )

export type RelayJoinState =
  | "waiting"
  | "announced"
  | "confirming"
  | "needs_review"
  | "paired"
  | "expired"
  | "revoked"

type RelayJoinProgress = "pairing" | "saved" | "connected" | "installation"

/** What someone confirmed a join with, frozen when they did. */
interface RelayJoinIntent {
  readonly creatorUserId: string | null
  readonly createdBy: string
  readonly envelopeDigest: string
  readonly expectedInstallationId: string | null
  readonly installation: "keep" | "use"
  readonly installationOperationId: string | null
  readonly name: string | null
  // The Hearth client a rotation replaces, revoked once the new one works.
  readonly previousClientId: string | null
  readonly replacesRelayId: string | null
  readonly targetInstallationId: string | null
}

interface ObservedInstallation {
  readonly fixed: boolean
  readonly id: string | null
}

interface RelayJoinRow extends RowDataPacket {
  announced_at: number | string | null
  claim_generation: number
  claimed_fingerprint: string | null
  client_private_key_ciphertext: string | null
  client_public_key: string
  created_at: number | string
  created_by: string
  envelope: RelayJoinEnvelope | string | null
  envelope_digest: string | null
  error: string | null
  expires_at: number | string
  features: ReadonlyArray<string> | string | null
  id: string
  intent: RelayJoinIntent | string | null
  lease_until: number | string | null
  observed_installation: ObservedInstallation | string | null
  paired_relay_id: string | null
  // Hearth's pairing request, and the Relay's signed reply, for a Relay that
  // pairs through its announcements.
  pairing_request: RelayPairingRequestContract | string | null
  pairing_response: RelayPairingResponseContract | string | null
  progress: RelayJoinProgress | null
  secret_ciphertext: string | null
  state: RelayJoinState
}

/** A join as the dialog sees it. */
export interface RelayJoinView {
  readonly announcement: {
    readonly controlEndpoint: string
    // Another Relay Hearth has at the address this one gives, which has
    // to go before this one can be added.
    readonly addressTakenBy: {
      readonly id: string
      readonly name: string
    } | null
    // What the Relay is called when nobody names it.
    readonly defaultName: string
    readonly envelopeDigest: string
    // The Relay Hearth already has under this fingerprint, if any.
    readonly existingRelay: {
      readonly id: string
      readonly name: string
    } | null
    readonly installation: {
      readonly fixed: boolean
      readonly id: string | null
      readonly replace: boolean
    }
    readonly managedTls: boolean
    readonly relayBuild: string
    readonly relayFingerprint: string
    readonly relayName: string
    // Whether the Relay pairs through its announcements and connects to
    // Hearth itself, so it can be added though Hearth can't reach it.
    readonly reachesHearth: boolean
    // Why Hearth can't reach the Relay yet, while it waits to be confirmed.
    readonly unreachable: string | null
  } | null
  readonly error: string | null
  readonly expiresAt: number
  // This Hearth's installation ID, which a Relay can take.
  readonly hearthInstallationId: string | null
  readonly id: string
  readonly intent: {
    readonly installation: "keep" | "use"
    readonly name: string | null
  } | null
  // The installation the Relay reported after it paired, when it isn't
  // what was reviewed.
  readonly observedInstallation: ObservedInstallation | null
  readonly pairedRelayId: string | null
  readonly progress: RelayJoinProgress | null
  readonly state: RelayJoinState
}

/** A join with what its command carries, for the person who owns it. */
export interface OpenedRelayJoin extends RelayJoinView {
  // Where this Hearth is, which the command names.
  readonly hearthOrigin: string
  readonly installScript: string
  // Whether this Hearth is a nightly, so the Relay is too.
  readonly nightly: boolean
  // The code the command carries, while it's waiting for its Relay.
  readonly secret: string | null
}

export class RelayJoinFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RelayJoinFailure"
  }
}

// ---------------------------------------------------------------- reading

const SELECT_JOIN = `SELECT id, created_by, secret_ciphertext, client_public_key,
         client_private_key_ciphertext, expires_at, state, progress, envelope,
         envelope_digest, announced_at, intent, observed_installation,
         claim_generation, lease_until, claimed_fingerprint, paired_relay_id,
         error, created_at, features, pairing_request, pairing_response
    FROM ${databaseTable("relay_join")}`

function json<T>(value: T | string | null): T | null {
  return typeof value === "string" ? (JSON.parse(value) as T) : value
}

const loadJoin = Effect.fn("relayJoin.load")(function* (
  joinId: string,
  userId?: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<RelayJoinRow>(
    "relay_join_load",
    `${SELECT_JOIN} WHERE id = ?${userId ? " AND created_by = ?" : ""} LIMIT 1`,
    userId ? [joinId, userId] : [joinId]
  )
  return rows[0] ?? null
})

const joinView = Effect.fn("relayJoin.view")(function* (row: RelayJoinRow) {
  const envelope = json(row.envelope)
  const intent = json(row.intent)
  const relays =
    envelope && row.state !== "paired"
      ? yield* promiseEffect(listPersistedRelays)
      : []
  const existing = envelope
    ? (relays.find((relay) => relay.id === envelope.relayFingerprint) ?? null)
    : null
  const unreachable =
    envelope && row.state === "announced"
      ? yield* promiseEffect(() => relayReachProblem(row.id, envelope))
      : null
  const addressTakenBy =
    envelope && !(unreachable && pairsThroughAnnouncements(row))
      ? relayAtAddress(envelope, relays)
      : null
  const defaultName =
    existing?.name ??
    (envelope
      ? relayNameForNewPairing(
          envelope.relayName,
          relays.map((relay) => relay.name)
        )
      : null)
  return {
    announcement:
      envelope && row.envelope_digest && defaultName
        ? {
            addressTakenBy: addressTakenBy
              ? { id: addressTakenBy.id, name: addressTakenBy.name }
              : null,
            controlEndpoint: envelope.controlEndpoint,
            defaultName,
            envelopeDigest: row.envelope_digest,
            existingRelay: existing
              ? { id: existing.id, name: existing.name }
              : null,
            installation: envelope.installation,
            managedTls: envelope.caCertificatePem !== null,
            reachesHearth: pairsThroughAnnouncements(row),
            relayBuild: envelope.relayBuild,
            relayFingerprint: envelope.relayFingerprint,
            relayName: envelope.relayName,
            unreachable,
          }
        : null,
    error: row.error,
    expiresAt: Number(row.expires_at),
    hearthInstallationId: loadedKilnInstallationId(),
    id: row.id,
    intent: intent
      ? { installation: intent.installation, name: intent.name }
      : null,
    observedInstallation:
      row.state === "needs_review" ? json(row.observed_installation) : null,
    pairedRelayId: row.paired_relay_id,
    progress: row.progress,
    state: row.state,
  } satisfies RelayJoinView
})

// Another Relay Hearth saved at the address a joining one gives. Hearth
// keeps one Relay per address, as a machine set up again under a new
// identity still has its old one.
function relayAtAddress(
  envelope: RelayJoinEnvelope,
  relays: ReadonlyArray<PersistedRelay>
): PersistedRelay | null {
  const control = new URL(envelope.controlEndpoint)
  const port = Number(control.port || 443)
  return (
    relays.find(
      (relay) =>
        relay.id !== envelope.relayFingerprint &&
        relay.hostname === control.hostname &&
        relay.port === port
    ) ?? null
  )
}

// ------------------------------------------------------------ the dialog

/**
 * The person's open join, or a new one: what the Add Relay dialog shows
 * when it opens. A join someone was confirming comes back to finish.
 */
export const openRelayJoinEffect = Effect.fn("relayJoin.open")(function* (
  userId: string,
  // The join the installer linked to, when it's still this person's to
  // confirm; otherwise their newest.
  joinId?: string
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* expireJoins(userId, now)
  const rows = yield* database.queryRows<RelayJoinRow>(
    "relay_join_open",
    `${SELECT_JOIN}
      WHERE created_by = ?
        AND state IN ('waiting', 'announced', 'confirming', 'needs_review')
      ORDER BY id = ? DESC, created_at DESC
      LIMIT 1`,
    [userId, joinId ?? ""]
  )
  const row = rows[0] ?? (yield* createJoin(userId, now))
  yield* resumeIfAbandoned(row, now)
  return yield* openedJoin(row)
})

const openedJoin = Effect.fnUntraced(function* (row: RelayJoinRow) {
  const view = yield* joinView(row)
  const secret =
    row.state === "waiting" && row.secret_ciphertext
      ? decryptPrivateKey(row.secret_ciphertext).plaintext
      : null
  return {
    ...view,
    hearthOrigin: kilnPublicUrl().origin,
    installScript: kilnInstallScriptUrl(),
    nightly: isKilnNightlyVersion(import.meta.env.VITE_KILN_VERSION ?? ""),
    secret,
  } satisfies OpenedRelayJoin
})

const createJoin = Effect.fnUntraced(function* (userId: string, now: number) {
  const database = yield* Database
  const secret = joinCode()
  const id = relayJoinId(secret)
  const keys = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
  yield* database.execute(
    "relay_join_create",
    `INSERT INTO ${databaseTable("relay_join")} (
        id, created_by, secret_ciphertext, client_public_key,
        client_private_key_ciphertext, expires_at, state, created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`,
    [
      id,
      userId,
      encryptPrivateKey(secret),
      keys.publicKey,
      encryptPrivateKey(keys.privateKey),
      now + RELAY_JOIN_LIFETIME_MS,
      now,
      now,
    ]
  )
  const created = yield* loadJoin(id, userId)
  if (!created) return yield* Effect.die(new Error("A new join vanished"))
  return created
})

// Joins nobody finished in time, and old finished ones, which keep their
// secret a day to tell their Relay how it went.
const expireJoins = Effect.fnUntraced(function* (userId: string, now: number) {
  const database = yield* Database
  yield* database.execute(
    "relay_join_expire",
    `UPDATE ${databaseTable("relay_join")}
        SET state = 'expired', client_private_key_ciphertext = NULL,
            updated_at = ?
      WHERE created_by = ? AND state IN ('waiting', 'announced')
        AND expires_at <= ?`,
    [now, userId, now]
  )
  yield* database.execute(
    "relay_join_prune",
    `DELETE FROM ${databaseTable("relay_join")}
      WHERE created_by = ? AND state IN ('paired', 'expired', 'revoked')
        AND updated_at <= ?`,
    [userId, now - TERMINAL_RETENTION_MS]
  )
})

/** A join for the dialog's polling; it never carries the secret. */
export const relayJoinViewEffect = Effect.fn("relayJoin.get")(function* (
  userId: string,
  joinId: string
) {
  const now = yield* Clock.currentTimeMillis
  yield* expireJoins(userId, now)
  const row = yield* loadJoin(joinId, userId)
  if (!row) return yield* Effect.fail(new RelayJoinFailure("Join not found"))
  yield* resumeIfAbandoned(row, now)
  return yield* joinView(row)
})

/**
 * A new command: the old join can no longer pair anything, and tells its
 * Relay it expired. Not while a Relay is being added from it, nor once
 * Hearth saved that Relay; one whose adding stopped on an error before
 * that can go, and frees the Relay to join again.
 */
export const refreshRelayJoinEffect = Effect.fn("relayJoin.refresh")(function* (
  userId: string,
  joinId: string
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const revoked = yield* database.execute(
    "relay_join_revoke",
    `UPDATE ${databaseTable("relay_join")}
          SET state = 'revoked', client_private_key_ciphertext = NULL,
              claimed_fingerprint = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND created_by = ?
          AND (state IN ('waiting', 'announced')
            OR (state = 'confirming' AND error IS NOT NULL
              AND (progress IS NULL OR progress = 'pairing')))`,
    [now, joinId, userId]
  )
  joinChanged(joinId)
  if (revoked.affectedRows === 0) {
    const row = yield* loadJoin(joinId, userId)
    if (row?.state === "confirming" || row?.state === "needs_review") {
      return yield* Effect.fail(
        new RelayJoinFailure(
          "A Relay is being added from this command; finish or wait for it first"
        )
      )
    }
  }
  return yield* openedJoin(yield* createJoin(userId, now))
})

// ------------------------------------------------------- the announcement

const decodeAnnouncement = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayJoinAnnouncementSchema)
)

/**
 * `/api/relays/join`: a Relay announcing itself with a join's link. It
 * does nothing beyond the database: no request goes anywhere until someone
 * confirms the Relay.
 */
export const answerRelayJoinAnnouncement = Effect.fn("relayJoin.answer")(
  function* (request: Request, clientAddress: string) {
    // Limited before anything is read, and read no further than an
    // announcement can be: anyone can send to this.
    const limited = Result.try(() =>
      assertRequestRateLimit(`relay.join:${clientAddress}`, 60, 60_000)
    )
    if (Result.isFailure(limited)) {
      return Response.json({ error: "Too many requests" }, { status: 429 })
    }
    const text = yield* promiseEffect(() =>
      readLimitedText(request, ANNOUNCEMENT_BYTES)
    )
    if (text === null) {
      return Response.json({ error: "Too large" }, { status: 413 })
    }
    const announcement = decodeAnnouncement(text)
    if (Option.isNone(announcement)) {
      return Response.json(
        { error: "Not a join announcement" },
        { status: 400 }
      )
    }
    const { joinId } = announcement.value
    const answer = yield* acceptAnnouncement(announcement.value)
    joinChanged(joinId)
    const holdMs = Math.min(
      Number(request.headers.get(relayJoinHoldHeader)) || 0,
      RELAY_JOIN_HOLD_MAX_MS
    )
    const saved = (current: typeof answer): Record<string, string> =>
      "saved" in current && current.saved ? { [relayJoinSavedHeader]: "1" } : {}
    // Not news the Relay hasn't heard: that Hearth saved it, as when that
    // happened between two announcements.
    const heardSaved = request.headers.get(relayJoinSavedHeader) === "1"
    if (
      answer.key === null ||
      holdMs <= 0 ||
      ("saved" in answer && answer.saved && !heardSaved)
    ) {
      return Response.json(answer.body, {
        headers: saved(answer),
        status: answer.status,
      })
    }
    // Held until there's something new to tell the Relay, so it hears the
    // moment someone confirms it, and hears its reply was taken only once
    // Hearth saved it: it dials Hearth then, and Hearth knows it.
    const start = yield* Clock.currentTimeMillis
    let changed = false
    while (!changed && !request.signal.aborted) {
      const left = start + holdMs - (yield* Clock.currentTimeMillis)
      if (left <= 0) break
      changed = yield* Effect.scoped(
        Effect.gen(function* () {
          const untilChange = yield* watchJoin(joinId)
          // Not a span each look: the hold's own span says how long it took.
          const row = yield* Effect.withTracerEnabled(loadJoin(joinId), false)
          if (!row || joinKey(row) !== answer.key) return true
          yield* untilChange(Math.min(left, HOLD_RECHECK_MS))
          return false
        })
      )
    }
    yield* Effect.annotateCurrentSpan({
      "relay_join.held_ms": (yield* Clock.currentTimeMillis) - start,
      "relay_join.changed": changed,
    })
    const final = changed
      ? yield* acceptAnnouncement(announcement.value)
      : answer
    return Response.json(final.body, {
      headers: { [relayJoinHeldHeader]: "1", ...saved(final) },
      status: final.status,
    })
  }
)

// What the join's Relay acts on: whether the answer carries Hearth's
// pairing request, whether Hearth saved the Relay, and how the join ended.
// Someone confirming it is news once the worker asks it to pair.
function joinKey(row: RelayJoinRow): string {
  const pending =
    row.state === "announced" ||
    row.state === "confirming" ||
    row.state === "needs_review"
  return [
    pending ? "pending" : row.state,
    row.state === "confirming" && row.pairing_request && !row.pairing_response
      ? "asking"
      : "",
    row.progress !== null && row.progress !== "pairing" ? "saved" : "",
  ].join("|")
}

const acceptAnnouncement = Effect.fn("relayJoin.announce")(function* (
  announcement: typeof RelayJoinAnnouncementSchema.Type
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  return yield* database.transaction("relay_join_announce", (transaction) =>
    Effect.gen(function* () {
      const rows = yield* transaction.queryRows<RelayJoinRow>(
        `${SELECT_JOIN} WHERE id = ? LIMIT 1 FOR UPDATE`,
        [announcement.joinId]
      )
      const row = rows[0]
      if (!row?.secret_ciphertext) {
        return { body: { error: "Unknown join" }, key: null, status: 404 }
      }
      const secret = decryptPrivateKey(row.secret_ciphertext).plaintext
      const expected = createHmac("sha256", secret)
        .update(relayJoinAnnouncementTranscript(announcement))
        .digest()
      const actual = Buffer.from(announcement.mac, "base64url")
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      ) {
        return {
          body: { error: "Not this join's Relay" },
          key: null,
          status: 403,
        }
      }
      // A pending answer tells the Relay which of Hearth's clients may pair
      // with it, and until when.
      const answer = (status: RelayJoinStatus) => {
        // Once confirmed, a Relay that pairs through its announcements gets
        // Hearth's pairing request until its reply arrives.
        const pairingRequest =
          row.state === "confirming" && !row.pairing_response
            ? json(row.pairing_request)
            : null
        const response = {
          clientId:
            status === "pending"
              ? publicKeyFingerprint(row.client_public_key)
              : null,
          expiresAt: status === "pending" ? Number(row.expires_at) : null,
          ...(status === "pending" && pairingRequest
            ? {
                pairing: {
                  dialUrl: hearthDialUrl(),
                  request: pairingRequest,
                },
              }
            : {}),
          status,
        }
        return {
          body: {
            ...response,
            mac: createHmac("sha256", secret)
              .update(
                relayJoinResponseTranscript({
                  ...response,
                  joinId: row.id,
                  nonce: announcement.nonce,
                })
              )
              .digest("base64url"),
          },
          // Only a pending answer can be held for a newer one, and not one
          // carrying Hearth's pairing request, which the Relay acts on.
          key: status === "pending" && !pairingRequest ? joinKey(row) : null,
          saved:
            row.state === "paired" ||
            (row.progress !== null && row.progress !== "pairing"),
          status: 200,
        }
      }
      const digest = envelopeDigest(announcement.envelope)
      // The Relay's reply to Hearth's pairing request, kept once it checks
      // out for the Relay this join announced; the worker carries on with it.
      const request = json(row.pairing_request)
      const envelope = json(row.envelope)
      if (
        announcement.pairing &&
        request &&
        envelope &&
        !row.pairing_response &&
        digest === row.envelope_digest &&
        Result.isSuccess(
          Result.try(() =>
            verifyPairingResponse(
              envelope,
              request.nonce,
              announcement.pairing as RelayPairingResponseContract
            )
          )
        )
      ) {
        yield* transaction.execute(
          `UPDATE ${databaseTable("relay_join")}
              SET pairing_response = ?, updated_at = ?
            WHERE id = ?`,
          [JSON.stringify(announcement.pairing), now, row.id]
        )
        row.pairing_response = announcement.pairing
      }
      switch (row.state) {
        case "revoked":
        case "expired":
          return answer("expired")
        case "paired":
          return answer(digest === row.envelope_digest ? "paired" : "claimed")
        case "announced":
        case "confirming":
        case "needs_review":
          return answer(digest === row.envelope_digest ? "pending" : "claimed")
        case "waiting": {
          if (Number(row.expires_at) <= now) {
            yield* transaction.execute(
              `UPDATE ${databaseTable("relay_join")}
                  SET state = 'expired', client_private_key_ciphertext = NULL,
                      updated_at = ?
                WHERE id = ?`,
              [now, row.id]
            )
            return answer("expired")
          }
          const problem = envelopeProblem(announcement.envelope, row.id)
          if (problem) {
            return { body: { error: problem }, key: null, status: 422 }
          }
          yield* transaction.execute(
            `UPDATE ${databaseTable("relay_join")}
                SET state = 'announced', envelope = ?, envelope_digest = ?,
                    features = ?, announced_at = ?, updated_at = ?
              WHERE id = ? AND state = 'waiting'`,
            [
              JSON.stringify(announcement.envelope),
              digest,
              JSON.stringify(announcement.features ?? []),
              now,
              now,
              row.id,
            ]
          )
          // At once, however long the Relay would wait: this answer makes
          // its invitation, and the installer prints the link to confirm
          // it then.
          return { ...answer("pending"), key: null }
        }
      }
    })
  )
})

function envelopeDigest(envelope: RelayJoinEnvelope): string {
  return createHash("sha256")
    .update(
      relayJoinAnnouncementTranscript({
        envelope,
        joinId: "",
        nonce: "",
        version: 1,
      })
    )
    .digest("hex")
}

// Why an announced envelope can't be used, or null. Joining needs the
// Relay's own TLS: everything after pairing, including replacing its
// installation ID, relies on it.
function envelopeProblem(
  envelope: RelayJoinEnvelope,
  joinId: string
): string | null {
  if (envelope.invitationId !== joinId)
    return "The invitation isn't this join's"
  if (
    !URL.canParse(envelope.controlEndpoint) ||
    !URL.canParse(envelope.browserOrigin)
  ) {
    return "The Relay's addresses aren't URLs"
  }
  const control = new URL(envelope.controlEndpoint)
  const origin = new URL(envelope.browserOrigin)
  if (
    control.protocol !== "wss:" ||
    origin.protocol !== "https:" ||
    control.pathname !== "/v1/socket" ||
    control.username ||
    control.password ||
    control.search ||
    control.hash ||
    origin.origin !== envelope.browserOrigin ||
    control.hostname !== origin.hostname ||
    (control.port || "443") !== (origin.port || "443")
  ) {
    return "Joining needs one HTTPS listener on the Relay"
  }
  const fingerprint = Result.try(() =>
    publicKeyFingerprint(envelope.relayPublicKeyPem)
  )
  if (
    Result.isFailure(fingerprint) ||
    fingerprint.success !== envelope.relayFingerprint
  ) {
    return "The Relay's fingerprint doesn't match its key"
  }
  return null
}

// ---------------------------------------------------------- confirming

/**
 * Confirms the announced Relay with a name and an installation-ID choice,
 * freezing them, and starts the worker that adds it. Asking again with the
 * same choices carries on with them; different ones are refused until the
 * first finishes or needs review.
 */
export const confirmRelayJoinEffect = Effect.fn("relayJoin.confirm")(
  function* (input: {
    readonly canManageAnyRelay: boolean
    readonly envelopeDigest: string
    readonly installation: "keep" | "use"
    readonly joinId: string
    readonly name: string | null
    readonly userId: string
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const hearthInstallationId = loadedKilnInstallationId()
    const claimed = yield* database.transaction(
      "relay_join_confirm",
      (transaction) =>
        Effect.gen(function* () {
          const rows = yield* transaction.queryRows<RelayJoinRow>(
            `${SELECT_JOIN} WHERE id = ? AND created_by = ? LIMIT 1 FOR UPDATE`,
            [input.joinId, input.userId]
          )
          const row = rows[0]
          if (!row)
            return yield* Effect.fail(new RelayJoinFailure("Join not found"))
          const envelope = json(row.envelope)
          if (!envelope || row.envelope_digest !== input.envelopeDigest) {
            return yield* Effect.fail(
              new RelayJoinFailure("The Relay changed; review it again")
            )
          }
          // Machines behind one router share its address, so it says
          // nothing about a Relay that connects to Hearth itself and that
          // Hearth can't reach there.
          const sharesAddress =
            pairsThroughAnnouncements(row) &&
            (yield* promiseEffect(() =>
              relayReachProblem(row.id, envelope)
            )) !== null
          const holder = sharesAddress
            ? null
            : relayAtAddress(
                envelope,
                yield* promiseEffect(listPersistedRelays)
              )
          if (holder) {
            return yield* Effect.fail(
              new RelayJoinFailure(
                `${holder.name} is already at this Relay's address; remove it first`
              )
            )
          }
          const name = input.name?.trim() || null
          if (row.state === "confirming") {
            const intent = json(row.intent)
            if (
              intent?.installation !== input.installation ||
              intent.name !== name
            ) {
              return yield* Effect.fail(
                new RelayJoinFailure(
                  "This Relay is already being added with other choices"
                )
              )
            }
            if (Number(row.lease_until ?? 0) > now) return null
            // Its worker stopped: take over.
            yield* transaction.execute(
              `UPDATE ${databaseTable("relay_join")}
                  SET claim_generation = claim_generation + 1,
                      lease_until = ?, error = NULL, updated_at = ?
                WHERE id = ?`,
              [now + LEASE_MS, now, row.id]
            )
            return Number(row.claim_generation) + 1
          }
          if (row.state !== "announced" && row.state !== "needs_review") {
            return yield* Effect.fail(
              new RelayJoinFailure("This join can't be confirmed any more")
            )
          }
          if (row.state === "announced" && Number(row.expires_at) <= now) {
            return yield* Effect.fail(
              new RelayJoinFailure(
                "This join expired; refresh it for a new command"
              )
            )
          }
          const existing = yield* promiseEffect(() =>
            findPersistedRelayRow(envelope.relayFingerprint)
          )
          if (
            existing &&
            !input.canManageAnyRelay &&
            existing.created_by !== input.userId
          ) {
            return yield* Effect.fail(
              new RelayJoinFailure("You can only manage Relays you created")
            )
          }
          const observed =
            row.state === "needs_review"
              ? json(row.observed_installation)
              : null
          const reviewed = observed ?? envelope.installation
          const replace =
            input.installation === "use" &&
            hearthInstallationId !== null &&
            reviewed.id !== hearthInstallationId
          if (replace && (reviewed.fixed || !envelope.installation.replace)) {
            return yield* Effect.fail(
              new RelayJoinFailure(
                "This Relay's installation ID can't be replaced"
              )
            )
          }
          const intent: RelayJoinIntent = {
            createdBy: input.userId,
            creatorUserId: input.canManageAnyRelay ? null : input.userId,
            envelopeDigest: input.envelopeDigest,
            expectedInstallationId: reviewed.id,
            installation: input.installation,
            installationOperationId: replace ? randomUUID() : null,
            name,
            previousClientId:
              json(row.intent)?.previousClientId ?? existing?.client_id ?? null,
            replacesRelayId: existing?.id ?? null,
            targetInstallationId:
              input.installation === "use" ? hearthInstallationId : null,
          }
          yield* transaction
            .execute(
              `UPDATE ${databaseTable("relay_join")}
                  SET state = 'confirming', intent = ?,
                      claim_generation = claim_generation + 1,
                      lease_until = ?, claimed_fingerprint = ?, error = NULL,
                      updated_at = ?
                WHERE id = ? AND state = ?`,
              [
                JSON.stringify(intent),
                now + LEASE_MS,
                envelope.relayFingerprint,
                now,
                row.id,
                row.state,
              ]
            )
            .pipe(
              Effect.catchTag("DatabaseError", () =>
                Effect.fail(
                  new RelayJoinFailure(
                    "This Relay is already being added from another command"
                  )
                )
              )
            )
          return Number(row.claim_generation) + 1
        })
    )
    joinChanged(input.joinId)
    if (claimed !== null) yield* forkJoinWorker(input.joinId, claimed)
    const row = yield* loadJoin(input.joinId, input.userId)
    if (!row) return yield* Effect.fail(new RelayJoinFailure("Join not found"))
    return yield* joinView(row)
  }
)

// A confirmation whose worker stopped, such as when Hearth restarted,
// carries on when the dialog next asks about it.
const resumeIfAbandoned = Effect.fnUntraced(function* (
  row: RelayJoinRow,
  now: number
) {
  if (
    row.state !== "confirming" ||
    row.error !== null ||
    Number(row.lease_until ?? 0) > now
  ) {
    return
  }
  const database = yield* Database
  const taken = yield* database.execute(
    "relay_join_resume",
    `UPDATE ${databaseTable("relay_join")}
        SET claim_generation = claim_generation + 1, lease_until = ?,
            updated_at = ?
      WHERE id = ? AND claim_generation = ? AND state = 'confirming'`,
    [now + LEASE_MS, now, row.id, row.claim_generation]
  )
  if (taken.affectedRows === 1) {
    yield* forkJoinWorker(row.id, Number(row.claim_generation) + 1)
  }
})

// Its trace starts on its own, linked to the request that started it, such
// as the confirmation: a worker outlives that request.
const forkJoinWorker = Effect.fnUntraced(function* (
  joinId: string,
  generation: number
) {
  const startedBy = yield* Effect.option(Effect.currentSpan)
  const links: Array<Tracer.SpanLink> = Option.isSome(startedBy)
    ? [{ attributes: {}, span: startedBy.value }]
    : []
  forkAppWorker(
    driveJoin(joinId, generation).pipe(
      Effect.withSpan("relayJoin.drive", {
        attributes: {
          "relay_join.generation": generation,
          "relay_join.id": joinId,
        },
        links,
        root: true,
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning(`Adding the Relay for join ${joinId} stopped`, cause)
      )
    )
  )
})

// ---------------------------------------------------------- the worker

class StaleClaim extends Error {}

// Writes as this claim, failing when a newer one took over.
const claimWrite = Effect.fnUntraced(function* (
  joinId: string,
  generation: number,
  set: string,
  values: Array<string | number | null>,
  // Whether the claim lets go of its lease, as a stopped worker does so
  // Try again takes over at once.
  lease: "renew" | "release" = "renew"
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const result = yield* database.execute(
    "relay_join_claim_write",
    `UPDATE ${databaseTable("relay_join")}
        SET ${set}, lease_until = ?, updated_at = ?
      WHERE id = ? AND claim_generation = ? AND state = 'confirming'`,
    [...values, lease === "renew" ? now + LEASE_MS : 0, now, joinId, generation]
  )
  if (result.affectedRows === 0) return yield* Effect.fail(new StaleClaim())
})

const driveJoin = Effect.fnUntraced(function* (
  joinId: string,
  generation: number
) {
  let renewedAt = 0
  while (true) {
    const next = yield* Effect.scoped(
      Effect.gen(function* () {
        // Before looking at the join, so a reply that lands meanwhile ends
        // the wait for it.
        const untilChange = yield* watchJoin(joinId)
        const row = yield* loadJoin(joinId)
        if (
          !row ||
          row.state !== "confirming" ||
          Number(row.claim_generation) !== generation
        ) {
          return "stop" as const
        }
        const now = yield* Clock.currentTimeMillis
        if (now - renewedAt > LEASE_RENEW_MS) {
          yield* claimWrite(joinId, generation, "error = error", [])
          renewedAt = now
        }
        return yield* joinStep(row, generation, untilChange).pipe(
          Effect.as("next" as const),
          Effect.catch((cause) =>
            cause instanceof StaleClaim
              ? Effect.succeed("stop" as const)
              : // The dialog shows why and offers to try again, which takes
                // over this claim.
                claimWrite(
                  joinId,
                  generation,
                  "error = ?",
                  [errorMessage(cause)],
                  "release"
                ).pipe(
                  Effect.as("stop" as const),
                  Effect.catch(() => Effect.succeed("stop" as const))
                )
          )
        )
      })
    )
    // Outside the watch, so the worker doesn't wake itself.
    joinChanged(joinId)
    if (next === "stop") return
  }
})

const joinStep = Effect.fnUntraced(function* (
  row: RelayJoinRow,
  generation: number,
  // Until the join changes, or the given time passes.
  untilChange: (ms: number) => Effect.Effect<void>
) {
  const intent = json(row.intent)
  const envelope = json(row.envelope)
  if (!intent || !envelope) {
    return yield* Effect.fail(new Error("The join lost what was confirmed"))
  }
  switch (row.progress) {
    case null:
    case "pairing":
      return yield* pairJoinedRelay(
        row,
        envelope,
        intent,
        generation,
        untilChange
      )
    case "saved":
      return yield* connectJoinedRelay(row, envelope, intent, generation)
    case "connected":
      return yield* applyInstallation(row, envelope, intent, generation)
    case "installation":
      return yield* recoverInstallation(row, envelope, intent, generation)
  }
})

// Pairs with the Relay using the join's key, then saves it, credentials and
// all, in the transaction that records the join's progress. A lost answer
// is asked again with the same key, which the Relay answers for the client
// it already paired.
const pairJoinedRelay = Effect.fn("relayJoin.pair")(function* (
  row: RelayJoinRow,
  envelope: RelayJoinEnvelope,
  intent: RelayJoinIntent,
  generation: number,
  untilChange: (ms: number) => Effect.Effect<void>
) {
  const now = yield* Clock.currentTimeMillis
  if (row.progress === null) {
    if (Number(row.expires_at) <= now) {
      return yield* finishJoin(row.id, generation, "expired", null)
    }
    yield* claimWrite(row.id, generation, "progress = 'pairing'", [])
  }
  if (!row.client_private_key_ciphertext || !row.secret_ciphertext) {
    return yield* Effect.fail(new Error("The join's key is gone"))
  }
  const privateKey = decryptPrivateKey(
    row.client_private_key_ciphertext
  ).plaintext
  const secret = decryptPrivateKey(row.secret_ciphertext).plaintext
  // A Relay that pairs through its announcements is never reached here: it
  // takes the request from Hearth's next answer and replies in its next
  // announcement, which `acceptAnnouncement` keeps.
  const throughAnnouncements = pairsThroughAnnouncements(row)
  const saved = json(row.pairing_request)
  const request = saved ?? pairingRequest(row, envelope, secret, privateKey)
  if (throughAnnouncements && !saved) {
    yield* claimWrite(row.id, generation, "pairing_request = ?", [
      JSON.stringify(request),
    ])
    return
  }
  const nonce = request.nonce
  const reply = json(row.pairing_response)
  if (throughAnnouncements && !reply) {
    if (Number(row.expires_at) <= now) {
      return yield* Effect.fail(
        new RelayJoinFailure(
          "The Relay stopped announcing itself before it paired. Check that it's still running, then try again."
        )
      )
    }
    yield* untilChange(REPLY_POLL_MS)
    return
  }
  const response = throughAnnouncements
    ? pairingResponseSchema.parse(reply)
    : yield* postJoinPairingRequest(envelope, request)
  // One kept past its expiry, as across a restart, is asked for again: the
  // next answer carries the request once more, and the Relay signs anew.
  if (throughAnnouncements && response.expiresAt <= Date.now()) {
    yield* claimWrite(row.id, generation, "pairing_response = NULL", [])
    return
  }
  verifyPairingResponse(envelope, nonce, response)
  if (response.clientId !== publicKeyFingerprint(row.client_public_key)) {
    return yield* Effect.fail(
      new Error("Relay paired an unexpected Hearth client identity")
    )
  }
  const existing = intent.replacesRelayId
    ? yield* promiseEffect(() =>
        findPersistedRelayRow(intent.replacesRelayId ?? "")
      )
    : null
  const name =
    intent.name ??
    existing?.name ??
    relayNameForNewPairing(
      response.relayName,
      (yield* promiseEffect(listPersistedRelays)).map((relay) => relay.name)
    )
  const control = new URL(envelope.controlEndpoint)
  yield* persistPairedRelayEffect({
    alsoInTransaction: (transaction) =>
      Effect.gen(function* () {
        const saved = yield* transaction.execute(
          `UPDATE ${databaseTable("relay_join")}
              SET progress = 'saved', paired_relay_id = ?,
                  client_private_key_ciphertext = NULL, updated_at = ?
            WHERE id = ? AND claim_generation = ? AND state = 'confirming'`,
          [envelope.relayFingerprint, Date.now(), row.id, generation]
        )
        if (saved.affectedRows === 0)
          return yield* Effect.fail(new StaleClaim())
      }),
    browserOrigin: new URL(envelope.browserOrigin).origin,
    clientActions: JSON.stringify(response.actions),
    clientId: response.clientId,
    clientPrivateKeyCiphertext: encryptPrivateKey(privateKey),
    clientPublicKey: row.client_public_key,
    clientRole: response.role,
    // A Relay that dials Hearth keeps doing so; Hearth's own connection is
    // the fallback, when it can reach the Relay at all.
    ...(throughAnnouncements ? { controlDial: "relay" as const } : {}),
    createdBy: intent.createdBy,
    creatorUserId: intent.creatorUserId,
    expectedExisting: existing !== null,
    hostname: control.hostname,
    id: envelope.relayFingerprint,
    name,
    port: Number(control.port || 443),
    relayCaCertificate: envelope.caCertificatePem,
    relayPublicKey: envelope.relayPublicKeyPem,
    // Until the installation choice is applied over the session.
    sendInstallationId: false,
    useTls: true,
  })
  if (existing) {
    const { closeRelayConnection } = yield* promiseEffect(
      () => import("@/lib/relay-connection")
    )
    closeRelayConnection(envelope.relayFingerprint)
  }
  publishRelayCollectionChange(envelope.relayFingerprint, [intent.createdBy])
})

// Hearth's signed pairing request for a join's Relay, with the join's key.
function pairingRequest(
  row: RelayJoinRow,
  envelope: RelayJoinEnvelope,
  secret: string,
  privateKey: string
): RelayPairingRequestContract {
  const unsignedRequest: Omit<RelayPairingRequestContract, "signature"> = {
    bootstrapProof: null,
    hearthName: `Hearth on ${kilnPublicUrl().hostname}`,
    hearthOrigin: kilnPublicUrl().origin,
    invitationId: envelope.invitationId,
    nonce: randomBytes(32).toString("base64url"),
    publicKeyPem: row.client_public_key,
    token: createHmac("sha256", secret)
      .update(RELAY_JOIN_INVITATION_LABEL)
      .digest("base64url"),
    version: 1,
  }
  return {
    ...unsignedRequest,
    signature: sign(
      null,
      Buffer.from(
        relayPairingRequestTranscript({ ...unsignedRequest, signature: "" })
      ),
      privateKey
    ).toString("base64url"),
  }
}

// Sends a pairing request straight to a Relay that can't take it through
// its announcements.
const postJoinPairingRequest = Effect.fnUntraced(function* (
  envelope: RelayJoinEnvelope,
  request: RelayPairingRequestContract
) {
  const pairingOrigin = relayPairingOrigin({
    browserOrigin: new URL(envelope.browserOrigin),
    caCertificatePem: envelope.caCertificatePem,
  })
  yield* Effect.try({
    try: () =>
      assertRelayAddress(pairingOrigin.hostname.replace(/^\[|\]$/gu, "")),
    catch: (cause) => cause,
  })
  return yield* promiseEffect(async () =>
    pairingResponseSchema.parse(
      await postPairingRequest(
        new URL("/v1/pair", pairingOrigin),
        envelope.caCertificatePem,
        request,
        relayDestinationLookup
      )
    )
  )
})

// Whether a join's Relay pairs through its announcements and opens its
// control connection to Hearth, so Hearth needn't reach it.
function pairsThroughAnnouncements(row: RelayJoinRow): boolean {
  const features = json(row.features) ?? []
  return (
    features.includes(relayJoinPairingV1Feature) &&
    features.includes(relayControlDialV1Feature)
  )
}

// Reaches the Relay over its session and reads its installation ID, which
// may have changed since it announced itself.
const connectJoinedRelay = Effect.fn("relayJoin.connect")(function* (
  row: RelayJoinRow,
  envelope: RelayJoinEnvelope,
  intent: RelayJoinIntent,
  generation: number
) {
  yield* Effect.annotateCurrentSpan("relay.id", envelope.relayFingerprint)
  // Whether Hearth can reach the Relay itself, asked while it connects.
  const reach = pairsThroughAnnouncements(row)
    ? yield* Effect.forkChild(joinReach(row.id, envelope))
    : null
  const observed = yield* readInstallation(envelope.relayFingerprint)
  // The client this one replaces can't do anything without its key, which
  // Hearth no longer has; revoke it anyway.
  if (
    intent.previousClientId &&
    intent.previousClientId !== publicKeyFingerprint(row.client_public_key)
  ) {
    yield* relayCall(envelope.relayFingerprint, "relay.clients.revoke", {
      clientId: intent.previousClientId,
    }).pipe(
      Effect.withSpan("relayJoin.revokePreviousClient"),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Couldn't revoke the Relay's previous Hearth client",
          cause
        )
      )
    )
  }
  yield* promiseEffect(() =>
    inspectPersistedRelay(envelope.relayFingerprint)
  ).pipe(Effect.ignore)
  // Browsers can't reach a Relay Hearth can't, so its consoles and
  // transfers go through Hearth.
  if (reach && (yield* Fiber.join(reach)) !== null) {
    yield* useHearthForBrowsers(envelope.relayFingerprint).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Couldn't send the Relay's browser traffic through Hearth",
          cause
        )
      )
    )
  }
  yield* claimWrite(
    row.id,
    generation,
    "progress = 'connected', observed_installation = ?",
    [JSON.stringify(observed)]
  )
})

// Puts the Relay in `hearth` proxy mode, keeping its other proxy settings.
const useHearthForBrowsers = Effect.fn("relayJoin.useHearthForBrowsers")(
  function* (relayId: string) {
    const current = relayProxyReadSchema.parse(
      yield* relayCall(relayId, "relay.proxy.read", {
        includeDiagnostics: true,
      })
    )
    if (current.settings.mode === "hearth") return
    yield* relayCall(
      relayId,
      "relay.proxy.write",
      relayProxySettingsSchema.parse({ ...current.settings, mode: "hearth" }),
      240_000
    )
  }
)

const relayProxyReadSchema = z.object({
  settings: z.object({ mode: z.string() }).passthrough(),
})

const applyInstallation = Effect.fn("relayJoin.applyInstallation")(function* (
  row: RelayJoinRow,
  envelope: RelayJoinEnvelope,
  intent: RelayJoinIntent,
  generation: number
) {
  const observed = json(row.observed_installation)
  if (intent.installation === "keep" || !intent.targetInstallationId) {
    return yield* finishJoin(row.id, generation, "paired", false)
  }
  if (observed?.id === intent.targetInstallationId) {
    return yield* finishJoin(row.id, generation, "paired", true)
  }
  if (
    !observed ||
    observed.fixed ||
    observed.id !== intent.expectedInstallationId ||
    !intent.installationOperationId
  ) {
    return yield* needsReview(row.id, generation, observed)
  }
  yield* claimWrite(row.id, generation, "progress = 'installation'", [])
  yield* replaceInstallation(envelope, intent).pipe(Effect.ignore)
})

// After the replacement was sent: asks the Relay how it went, by the
// operation ID kept for it, and never sends that ID twice.
const recoverInstallation = Effect.fn("relayJoin.recoverInstallation")(
  function* (
    row: RelayJoinRow,
    envelope: RelayJoinEnvelope,
    intent: RelayJoinIntent,
    generation: number
  ) {
    const lookup = Schema.decodeUnknownSync(RelayOperationLookupSchema)(
      yield* relayCall(envelope.relayFingerprint, "operation.get", {
        operationId: intent.installationOperationId,
      })
    )
    switch (lookup.status) {
      case "succeeded":
        return yield* finishJoin(row.id, generation, "paired", true)
      case "running":
        yield* Effect.sleep("2 seconds")
        return
      case "failed":
      case "interrupted":
      case "unknown": {
        const current = yield* readInstallation(envelope.relayFingerprint)
        return current.id === intent.targetInstallationId
          ? yield* finishJoin(row.id, generation, "paired", true)
          : yield* needsReview(row.id, generation, current)
      }
    }
  }
)

const replaceInstallation = Effect.fnUntraced(function* (
  envelope: RelayJoinEnvelope,
  intent: RelayJoinIntent
) {
  const { relayRpc } = yield* promiseEffect(
    () => import("@/lib/relay-connection")
  )
  const relay = (yield* promiseEffect(listPersistedRelays)).find(
    (candidate) => candidate.id === envelope.relayFingerprint
  )
  if (!relay) return yield* Effect.fail(new Error("The Relay isn't saved"))
  yield* promiseEffect(() =>
    relayRpc(
      relay,
      "relay.installation.replace",
      {
        expectedInstallationId: intent.expectedInstallationId,
        installationId: intent.targetInstallationId,
      },
      30_000,
      intent.createdBy,
      undefined,
      { operationId: intent.installationOperationId ?? undefined }
    )
  )
})

const readInstallation = Effect.fn("relayJoin.readInstallation")(function* (
  relayId: string
) {
  let attempts = 0
  const read = yield* Effect.suspend(() => {
    attempts += 1
    return relayCall(relayId, "relay.installation.read", {})
  }).pipe(
    Effect.map((value) => relayInstallationSchema.parse(value)),
    Effect.retry(connectSchedule),
    Effect.ensuring(
      Effect.suspend(() =>
        Effect.annotateCurrentSpan("relay_join.attempts", attempts)
      )
    )
  )
  return {
    fixed: read.fixed,
    id: read.installationId,
  } satisfies ObservedInstallation
})

const relayCall = Effect.fnUntraced(function* (
  relayId: string,
  operation:
    | "relay.installation.read"
    | "relay.clients.revoke"
    | "relay.proxy.read"
    | "relay.proxy.write"
    | "operation.get",
  payload: unknown,
  timeoutMs = 10_000
) {
  const { relayRpc } = yield* promiseEffect(
    () => import("@/lib/relay-connection")
  )
  const relay = (yield* promiseEffect(listPersistedRelays)).find(
    (candidate) => candidate.id === relayId
  )
  if (!relay) return yield* Effect.fail(new Error("The Relay isn't saved"))
  return yield* promiseEffect(() =>
    relayRpc(relay, operation, payload, timeoutMs)
  )
})

const needsReview = Effect.fnUntraced(function* (
  joinId: string,
  generation: number,
  observed: ObservedInstallation | null
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const result = yield* database.execute(
    "relay_join_review",
    `UPDATE ${databaseTable("relay_join")}
        SET state = 'needs_review', progress = 'connected',
            observed_installation = ?, lease_until = NULL, updated_at = ?
      WHERE id = ? AND claim_generation = ? AND state = 'confirming'`,
    [JSON.stringify(observed), now, joinId, generation]
  )
  if (result.affectedRows === 0) return yield* Effect.fail(new StaleClaim())
})

// Ends the join. A paired Relay sends Hearth's installation ID from now on
// only when someone chose it and it's applied.
const finishJoin = Effect.fnUntraced(function* (
  joinId: string,
  generation: number,
  state: "paired" | "expired",
  sendInstallationId: boolean | null
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("relay_join_finish", (transaction) =>
    Effect.gen(function* () {
      const result = yield* transaction.execute(
        `UPDATE ${databaseTable("relay_join")}
            SET state = ?, lease_until = NULL, claimed_fingerprint = NULL,
                client_private_key_ciphertext = NULL, error = NULL,
                updated_at = ?
          WHERE id = ? AND claim_generation = ? AND state = 'confirming'`,
        [state, now, joinId, generation]
      )
      if (result.affectedRows === 0) return yield* Effect.fail(new StaleClaim())
      if (sendInstallationId !== null) {
        yield* transaction.execute(
          `UPDATE ${databaseTable("relay")} r
             JOIN ${databaseTable("relay_join")} j ON j.paired_relay_id = r.id
              SET r.send_installation_id = ?, r.updated_at = ?
            WHERE j.id = ?`,
          [sendInstallationId, now, joinId]
        )
      }
    })
  )
})

// ------------------------------------------------------------- network

// As long as pairing waits, so a Relay pairing would reach is never held
// back.
const REACH_TIMEOUT_MS = 10_000
// How long the dialog's question waits for an answer before it shows the
// last one; a slow check finishes for a later question.
const REACH_WAIT_MS = 1_000
// The dialog asks every two seconds; Hearth looks again at most this often.
const REACH_RECHECK_MS = 5_000
// A join nobody asked about for this long is forgotten.
const REACH_FORGET_MS = 60_000

interface ReachCheck {
  askedAt: number
  checkedAt: number
  checking: Promise<void> | null
  // Undefined until the first check finishes.
  problem: string | null | undefined
}
const reachChecks = new Map<string, ReachCheck>()

// Whether Hearth can open the Relay's HTTPS the way pairing will, so the
// dialog says what's wrong before anyone confirms: null when it can, or
// before the first check finishes.
async function relayReachProblem(
  joinId: string,
  envelope: RelayJoinEnvelope
): Promise<string | null> {
  const now = Date.now()
  for (const [id, check] of reachChecks) {
    if (!check.checking && now - check.askedAt > REACH_FORGET_MS) {
      reachChecks.delete(id)
    }
  }
  const check = reachChecks.get(joinId) ?? {
    askedAt: now,
    checkedAt: 0,
    checking: null,
    problem: undefined,
  }
  reachChecks.set(joinId, check)
  check.askedAt = now
  if (!check.checking && now - check.checkedAt > REACH_RECHECK_MS) {
    check.checking = relayReach(envelope).then((problem) => {
      check.problem = problem
      check.checkedAt = Date.now()
      check.checking = null
    })
  }
  if (check.checking && check.problem === undefined) {
    await Promise.race([check.checking, delay(REACH_WAIT_MS)])
  }
  return check.problem ?? null
}

// Whether Hearth can reach a join's Relay itself, for adding it: null when
// it can. The dialog's answer when this process has a recent one, as it
// does once someone confirmed the Relay here, or a check of its own.
const joinReach = Effect.fn("relayJoin.reach")(function* (
  joinId: string,
  envelope: RelayJoinEnvelope
) {
  const check = reachChecks.get(joinId)
  const age = (yield* Clock.currentTimeMillis) - (check?.checkedAt ?? 0)
  // That Hearth can't reach it holds for a while, and acting on it when it
  // no longer does only sends browsers through Hearth needlessly. That it
  // can holds only while fresh: acting on it when it no longer does leaves
  // browsers no way in. A check under way is quick when it can.
  const cached =
    check?.problem !== undefined &&
    age <= (check.problem === null ? REACH_RECHECK_MS : REACH_FORGET_MS)
  const problem =
    cached && check.problem !== undefined
      ? check.problem
      : yield* promiseEffect(() =>
          check?.checking
            ? check.checking.then(() => check.problem ?? null)
            : relayReach(envelope)
        )
  yield* Effect.annotateCurrentSpan({
    "relay_join.reach_cached": cached,
    "relay_join.reachable": problem === null,
  })
  return problem
})

function relayReach(envelope: RelayJoinEnvelope): Promise<string | null> {
  const origin = relayPairingOrigin({
    browserOrigin: new URL(envelope.browserOrigin),
    caCertificatePem: envelope.caCertificatePem,
  })
  const host = origin.hostname.replace(/^\[|\]$/gu, "")
  return new Promise((resolve) => {
    let socket: TLSSocket | null = null
    let settled = false
    const settle = (problem: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      socket?.destroy()
      resolve(problem)
    }
    const fail = (cause: unknown) =>
      settle(
        (
          mapPairingTransportError(cause) ??
          unreachablePairingError(cause, origin) ??
          new Error(errorMessage(cause))
        ).message
      )
    // Covers resolving the name too.
    const deadline = setTimeout(
      () => settle(unreachableRelayError(origin).message),
      REACH_TIMEOUT_MS
    )
    const opened = Result.try(() => {
      assertRelayAddress(host)
      return tlsConnect({
        ca: envelope.caCertificatePem ?? undefined,
        host,
        lookup: relayDestinationLookup,
        port: Number(origin.port || 443),
        servername: isIP(host) ? undefined : host,
      })
    })
    if (Result.isFailure(opened)) {
      fail(opened.failure)
      return
    }
    socket = opened.success
    socket.once("secureConnect", () => settle(null))
    socket.once("error", fail)
  })
}

// Without keeping the process up for a check that already finished.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref())
}

// Addresses Hearth never pairs with, whatever a Relay announces: link-local
// ones (cloud metadata services live there), unspecified, multicast, and
// broadcast. Private and loopback addresses are real Relays.
const forbiddenDestinations = (() => {
  const list = new BlockList()
  list.addSubnet("169.254.0.0", 16, "ipv4")
  list.addSubnet("0.0.0.0", 8, "ipv4")
  list.addSubnet("224.0.0.0", 4, "ipv4")
  list.addAddress("255.255.255.255", "ipv4")
  list.addSubnet("fe80::", 10, "ipv6")
  list.addAddress("::", "ipv6")
  list.addSubnet("ff00::", 8, "ipv6")
  return list
})()

function forbiddenAddress(address: string, family: number): boolean {
  return forbiddenDestinations.check(address, family === 6 ? "ipv6" : "ipv4")
}

// A Relay at an address rather than a name, which no lookup sees.
function assertRelayAddress(host: string): void {
  const family = isIP(host)
  if (family !== 0 && forbiddenAddress(host, family)) {
    throw new RelayJoinFailure(`Hearth won't connect to ${host}`)
  }
}

// Resolves a Relay's name for the connection itself, refusing any answer
// with a forbidden address, so what was checked is what's connected to.
const relayDestinationLookup: LookupFunction = (
  hostname,
  options,
  callback
) => {
  dnsLookup(
    hostname,
    {
      all: true,
      family: options.family,
      hints: options.hints,
      order: options.order ?? "verbatim",
    },
    (cause, addresses) => {
      if (cause) {
        callback(cause, "")
        return
      }
      const forbidden = addresses.find(({ address, family }) =>
        forbiddenAddress(address, family)
      )
      if (forbidden) {
        callback(
          new RelayJoinFailure(`Hearth won't connect to ${forbidden.address}`),
          ""
        )
        return
      }
      const selected = addresses.at(0)
      if (!selected) {
        callback(new Error(`${hostname} has no address`), "")
        return
      }
      if (options.all) callback(null, addresses)
      else callback(null, selected.address, selected.family)
    }
  )
}

// A join's code: 20 base32 letters, 100 bits.
function joinCode(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
  return [...randomBytes(20)].map((byte) => alphabet[byte & 31]).join("")
}

// A join's ID, derived from its code as the Relay derives it.
function relayJoinId(secret: string): string {
  return createHmac("sha256", secret)
    .update(RELAY_JOIN_ID_LABEL)
    .digest("base64url")
    .slice(0, 22)
}

function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.slice(0, 500)
}
