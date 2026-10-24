import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import {
  RELAY_JOIN_INVITATION_LABEL,
  RELAY_JOIN_LIFETIME_MS,
  type RelayJoinEnvelope,
  type RelayJoinLink,
  RelayJoinResponseSchema,
  type RelayJoinStatus,
  relayJoinAnnouncementTranscript,
  relayJoinResponseTranscript,
} from "@workspace/contracts"
import { Effect, Option, Schema } from "effect"

import { relayBuildLabel } from "../build-info.js"
import type { RelayConfig } from "../config.js"
import { createPairingInvitation, joinEnvelope } from "./pairing.js"
import type { RelayIdentity } from "./identity.js"
import type { RelayStateStore } from "./state.js"
import type { RelayTlsMaterial } from "./tls.js"

// Joining: a Relay started with a join link from Hearth's Add Relay dialog
// (KILN_RELAY_JOIN, or `kiln-relay pair join <link>` on a running Relay)
// pairs with that Hearth without anyone pasting an invitation. It makes one
// invitation that only the Hearth client the link names can use, then
// announces itself to Hearth until someone there confirms it, the join
// expires, or another Relay used the link first. See packages/contracts
// relay-join.ts for the link and the messages.

const JOIN_METADATA_PREFIX = "relay_join:"
const ANNOUNCE_INTERVAL_MS = 5_000
const MAX_RETRY_DELAY_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 4_096

export class RelayJoinError extends Schema.TaggedError<RelayJoinError>()(
  "RelayJoinError",
  { reason: Schema.String }
) {
  override get message() {
    return this.reason
  }
}

// What the Relay keeps of a join, so a restart neither makes a second
// invitation nor extends the first.
const SavedJoinSchema = Schema.fromJsonString(
  Schema.Struct({
    clientId: Schema.String,
    expiresAt: Schema.Number,
    hearthOrigin: Schema.String,
    joinId: Schema.String,
    outcome: Schema.NullOr(Schema.Literals(["paired", "expired", "claimed"])),
  })
)
type SavedJoin = typeof SavedJoinSchema.Type
const decodeSavedJoin = Schema.decodeUnknownOption(SavedJoinSchema)

export type RelayJoinOutcome = Exclude<RelayJoinStatus, "pending">

/** What joining reports as it goes, for the log or the terminal. */
export type RelayJoinEvent =
  | { readonly kind: "started"; readonly fingerprint: string }
  | { readonly kind: "insecure" }
  | { readonly kind: "waiting" }
  | { readonly kind: "unreachable"; readonly reason: string }
  | { readonly kind: "finished"; readonly outcome: RelayJoinOutcome }

export interface RelayJoinInput {
  readonly config: RelayConfig
  readonly identity: RelayIdentity
  readonly link: RelayJoinLink
  readonly state: RelayStateStore["Service"]
  readonly tls: RelayTlsMaterial | null
}

/**
 * Joins the Hearth the link names, announcing until it ends. Returns how it
 * ended; fails only when this Relay can't join at all.
 */
export const runRelayJoin = Effect.fnUntraced(function* (
  input: RelayJoinInput,
  report: (event: RelayJoinEvent) => void
) {
  const { link, state } = input
  if (new URL(input.config.browserOrigin).protocol !== "https:") {
    return yield* new RelayJoinError({
      reason:
        "Joining needs the Relay's own HTTPS (KILN_RELAY_TLS_MODE=managed). Pair this Relay by hand instead: run `kiln-relay pair create` and paste the link into Hearth.",
    })
  }
  const saved = yield* prepareJoin(input)
  if (saved.outcome) {
    report({ kind: "finished", outcome: saved.outcome })
    return saved.outcome
  }
  report({ kind: "started", fingerprint: input.identity.fingerprint })
  if (link.hearthOrigin.startsWith("http:")) report({ kind: "insecure" })
  const envelope = yield* joinEnvelope({
    config: input.config,
    expiresAt: saved.expiresAt,
    identity: input.identity,
    invitationId: link.joinId,
    relayBuild: relayBuildLabel(),
    tls: input.tls,
  })
  let delay = ANNOUNCE_INTERVAL_MS
  let waiting = false
  while (true) {
    if (yield* pairedLocally(state, link.joinId)) {
      return yield* finish(input, saved, "paired", report)
    }
    if (Date.now() >= saved.expiresAt) {
      return yield* finish(input, saved, "expired", report)
    }
    const answered = yield* announce(link, envelope).pipe(
      Effect.withSpan("RelayJoin.announce"),
      Effect.map((status) => ({ status })),
      Effect.catch((error: RelayJoinError) =>
        Effect.succeed({ reason: error.reason })
      )
    )
    if ("reason" in answered) {
      report({ kind: "unreachable", reason: answered.reason })
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS)
    } else if (answered.status === "pending") {
      if (!waiting) report({ kind: "waiting" })
      waiting = true
      delay = ANNOUNCE_INTERVAL_MS
    } else {
      return yield* finish(input, saved, answered.status, report)
    }
    yield* Effect.sleep(
      Math.min(delay, Math.max(0, saved.expiresAt - Date.now()))
    )
  }
})

// The saved join, saving it and its invitation the first time. The link's
// expiry is capped once, when the Relay first sees it, and kept.
const prepareJoin = Effect.fn("RelayJoin.prepare")(function* (
  input: RelayJoinInput
) {
  const { link, state } = input
  const key = `${JOIN_METADATA_PREFIX}${link.joinId}`
  const existing = Option.getOrNull(
    decodeSavedJoin((yield* state.getMetadata(key)) ?? "")
  )
  if (existing && existing.clientId !== link.clientId) {
    return yield* new RelayJoinError({
      reason: "This Relay already joined with a different link for that join",
    })
  }
  // Hearth's address may be corrected; who may pair and until when may not.
  const saved: SavedJoin = existing
    ? { ...existing, hearthOrigin: link.hearthOrigin }
    : {
        clientId: link.clientId,
        expiresAt: Math.min(
          link.expiresAt,
          Date.now() + RELAY_JOIN_LIFETIME_MS
        ),
        hearthOrigin: link.hearthOrigin,
        joinId: link.joinId,
        outcome: null,
      }
  if (!existing || existing.hearthOrigin !== link.hearthOrigin) {
    yield* state.setMetadata(key, JSON.stringify(saved))
  }
  if (saved.outcome || saved.expiresAt <= Date.now()) return saved
  // Saved first, so a restart between the two finds the join and makes the
  // invitation then.
  if (!(yield* state.findInvitationById(link.joinId))) {
    yield* createPairingInvitation({
      config: input.config,
      identity: input.identity,
      join: {
        clientId: link.clientId,
        expiresAt: saved.expiresAt,
        invitationId: link.joinId,
      },
      role: "full_access",
      state,
      tls: input.tls,
      token: relayJoinInvitationToken(link.secret),
    })
  }
  return saved
})

const finish = Effect.fnUntraced(function* (
  input: RelayJoinInput,
  saved: SavedJoin,
  outcome: RelayJoinOutcome,
  report: (event: RelayJoinEvent) => void
) {
  yield* input.state.setMetadata(
    `${JOIN_METADATA_PREFIX}${saved.joinId}`,
    JSON.stringify({ ...saved, outcome })
  )
  // An unused invitation from a join that ended can't pair anyone later.
  if (outcome !== "paired") {
    yield* input.state.revokeInvitation(saved.joinId, Date.now())
  }
  report({ kind: "finished", outcome })
  return outcome
})

const pairedLocally = Effect.fnUntraced(function* (
  state: RelayStateStore["Service"],
  joinId: string
) {
  const clients = yield* state.listClients()
  return clients.some((client) => client.invitationId === joinId)
})

// One announcement. Fails with why Hearth couldn't be asked, or answered
// in a way that can't be trusted, so the caller tries again later.
function announce(link: RelayJoinLink, envelope: RelayJoinEnvelope) {
  const nonce = randomBytes(32).toString("base64url")
  const unsigned = { envelope, joinId: link.joinId, nonce, version: 1 as const }
  const body = JSON.stringify({
    ...unsigned,
    mac: createHmac("sha256", link.secret)
      .update(relayJoinAnnouncementTranscript(unsigned))
      .digest("base64url"),
  })
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(
        new URL("/api/relays/join", link.hearthOrigin),
        {
          body,
          headers: { "content-type": "application/json" },
          method: "POST",
          // Never somewhere else, and never down to plain HTTP.
          redirect: "error",
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ]),
        }
      )
      const text = await response.text()
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error("Hearth's answer was too large")
      }
      return { ok: response.ok, status: response.status, text }
    },
    catch: (cause) =>
      new RelayJoinError({
        reason: `Hearth didn't answer: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap(({ ok, status, text }) => {
      const answer = Schema.decodeUnknownOption(
        Schema.fromJsonString(RelayJoinResponseSchema)
      )(text)
      if (Option.isNone(answer)) {
        return Effect.fail(
          new RelayJoinError({
            reason: ok
              ? "Hearth's answer wasn't one it could send"
              : `Hearth answered ${status}`,
          })
        )
      }
      const expected = createHmac("sha256", link.secret)
        .update(
          relayJoinResponseTranscript({
            joinId: link.joinId,
            nonce,
            status: answer.value.status,
          })
        )
        .digest()
      const actual = Buffer.from(answer.value.mac, "base64url")
      return expected.length === actual.length &&
        timingSafeEqual(expected, actual)
        ? Effect.succeed(answer.value.status)
        : Effect.fail(
            new RelayJoinError({
              reason: "Hearth's answer didn't prove it holds the join",
            })
          )
    })
  )
}

/** The pairing token of a join's invitation. */
export function relayJoinInvitationToken(secret: string): string {
  return createHmac("sha256", secret)
    .update(RELAY_JOIN_INVITATION_LABEL)
    .digest("base64url")
}

/** A line for the log or terminal about how joining is going. */
export function describeRelayJoinEvent(
  event: RelayJoinEvent,
  hearthOrigin: string
): string {
  switch (event.kind) {
    case "started":
      return `Joining the Kiln at ${hearthOrigin}. This Relay's fingerprint is ${event.fingerprint}; check Hearth shows the same.`
    case "insecure":
      return "Hearth's address is plain HTTP; joining relies on the network between the two machines."
    case "waiting":
      return "Waiting for someone to confirm this Relay in Hearth's Add Relay dialog."
    case "unreachable":
      return `${event.reason}. Trying again.`
    case "finished":
      return event.outcome === "paired"
        ? "Paired with Hearth."
        : event.outcome === "expired"
          ? "This join expired. In Hearth, open Add Relay again for a new command."
          : "Another Relay already joined with this link. In Hearth, open Add Relay again for a new command."
  }
}
