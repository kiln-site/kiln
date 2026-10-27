import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import {
  RELAY_JOIN_HOLD_MAX_MS,
  RELAY_JOIN_ID_LABEL,
  RELAY_JOIN_INVITATION_LABEL,
  RELAY_JOIN_LIFETIME_MS,
  relayControlDialV1Feature,
  relayJoinHeldHeader,
  relayJoinHoldHeader,
  relayJoinSavedHeader,
  relayJoinPairingV1Feature,
  type RelayJoinPairingResponseSchema,
  type RelayJoinEnvelope,
  RelayJoinEnvelopeSchema,
  type RelayJoinLink,
  type RelayJoinResponse,
  RelayJoinResponseSchema,
  type RelayJoinStatus,
  relayJoinAnnouncementTranscript,
  relayJoinConfirmUrl,
  relayJoinResponseTranscript,
} from "@workspace/contracts"
import { Effect, Option, Schema } from "effect"

import { relayBuildLabel } from "../build-info.js"
import type { RelayConfig } from "../config.js"
import { saveControlDial } from "../control-dial.js"
import {
  createPairingInvitation,
  decodePairingRequest,
  joinEnvelope,
  pairHearth,
} from "./pairing.js"
import type { RelayIdentity } from "./identity.js"
import type { RelayStateStore } from "./state.js"
import type { RelayTlsMaterial } from "./tls.js"

// Joining: a Relay started with a join link from Hearth's Add Relay dialog
// (KILN_RELAY_JOIN, or `kiln-relay pair join <link>` on a running Relay)
// pairs with that Hearth without anyone pasting an invitation. It announces
// itself to Hearth until someone there confirms it, the join expires, or
// another Relay used the link first. Hearth's first answer names the one
// Hearth client that may pair, and the Relay makes one invitation only that
// client can use. See packages/contracts relay-join.ts for the link and the
// messages.

const JOIN_METADATA_PREFIX = "relay_join:"
const ANNOUNCE_INTERVAL_MS = 5_000
const MAX_RETRY_DELAY_MS = 60_000
// A pairing reply this close to expiring is signed again before it's sent,
// so one that didn't arrive in time doesn't keep being refused.
const PAIRED_RENEW_MS = 20_000
const REQUEST_TIMEOUT_MS = 15_000
// Between announcements Hearth held: it answered because something changed,
// so the Relay asks again at once, but never in a tight loop.
const HELD_GAP_MS = 250
// Room for the pairing request a join's answer can carry.
const MAX_RESPONSE_BYTES = 16_384
// What the Relay tells Hearth it can do when it announces itself: pair
// through its announcements, and open its control connection to Hearth.
const JOIN_FEATURES = [relayJoinPairingV1Feature, relayControlDialV1Feature]

export class RelayJoinError extends Schema.TaggedError<RelayJoinError>()(
  "RelayJoinError",
  { reason: Schema.String }
) {
  override get message() {
    return this.reason
  }
}

// What the Relay keeps of a join, so a restart neither makes a second
// invitation nor extends the first, and announces the Relay as it first
// did: Hearth knows the Relay by that announcement, which a new
// installation ID or build would otherwise change.
const SavedJoinSchema = Schema.fromJsonString(
  Schema.Struct({
    clientId: Schema.NullOr(Schema.String),
    envelope: Schema.NullOr(RelayJoinEnvelopeSchema),
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
  | { readonly kind: "waiting"; readonly confirmUrl: string }
  | { readonly kind: "unreachable"; readonly reason: string }
  | { readonly kind: "finished"; readonly outcome: RelayJoinOutcome }

export interface RelayJoinInput {
  readonly config: RelayConfig
  readonly identity: RelayIdentity
  readonly link: RelayJoinLink
  readonly state: RelayStateStore["Service"]
  readonly tls: RelayTlsMaterial | null
  /**
   * Has the Relay server dial Hearth now, rather than on its next pass,
   * once Hearth has the Relay's reply and saved it.
   */
  readonly wakeDials?: Effect.Effect<void>
}

/** A join's ID, derived from its code. */
export function relayJoinId(secret: string): string {
  return createHmac("sha256", secret)
    .update(RELAY_JOIN_ID_LABEL)
    .digest("base64url")
    .slice(0, 22)
}

/** The pairing token of a join's invitation. */
export function relayJoinInvitationToken(secret: string): string {
  return createHmac("sha256", secret)
    .update(RELAY_JOIN_INVITATION_LABEL)
    .digest("base64url")
}

/**
 * Joins the Hearth the link names, announcing until it ends. Returns how it
 * ended; fails only when this Relay can't join at all.
 */
export const runRelayJoin = Effect.fnUntraced(function* (
  input: RelayJoinInput,
  report: (event: RelayJoinEvent) => void
) {
  const { link } = input
  if (new URL(input.config.browserOrigin).protocol !== "https:") {
    return yield* new RelayJoinError({
      reason:
        "Joining needs the Relay's own HTTPS (KILN_RELAY_TLS_MODE=managed). Pair this Relay by hand instead: run `kiln-relay pair create` and paste the link into Hearth.",
    })
  }
  let saved = yield* prepareJoin(input)
  if (saved.outcome) {
    report({ kind: "finished", outcome: saved.outcome })
    return saved.outcome
  }
  report({ kind: "started", fingerprint: input.identity.fingerprint })
  if (link.hearthOrigin.startsWith("http:")) report({ kind: "insecure" })
  let envelope = saved.envelope
  if (!envelope) {
    envelope = yield* joinEnvelope({
      config: input.config,
      identity: input.identity,
      invitationId: saved.joinId,
      relayBuild: relayBuildLabel(),
      tls: input.tls,
    })
    saved = { ...saved, envelope }
    yield* input.state.setMetadata(
      `${JOIN_METADATA_PREFIX}${saved.joinId}`,
      JSON.stringify(saved)
    )
  }
  let delay = ANNOUNCE_INTERVAL_MS
  let waiting = false
  // Whether the Relay server was told to dial Hearth.
  let woken = false
  // The Relay's reply to the pairing request Hearth's answer carried, sent
  // with each announcement until Hearth says it's paired.
  let paired: typeof RelayJoinPairingResponseSchema.Type | null = null
  // Only Hearth's answer says it's paired: Hearth pairs, then saves the
  // Relay, and pairing here alone doesn't mean it saved it.
  while (true) {
    if (Date.now() >= saved.expiresAt) {
      return yield* finish(input, saved, "expired", report)
    }
    const answered:
      | {
          readonly held: boolean
          readonly response: RelayJoinResponse
          readonly saved: boolean
        }
      | { readonly reason: string } = yield* announce(
      link,
      saved.joinId,
      envelope,
      paired,
      // Once the Relay has its invitation, Hearth may hold the next
      // announcement until it has news.
      waiting ? RELAY_JOIN_HOLD_MAX_MS : 0,
      woken
    ).pipe(
      Effect.withSpan("RelayJoin.announce", {
        attributes: {
          "relay_join.id": saved.joinId,
          "relay_join.reply": paired !== null,
        },
      }),
      Effect.catch((error: RelayJoinError) =>
        Effect.succeed({ reason: error.reason })
      )
    )
    // Hearth has the Relay, so it can dial Hearth now: Hearth says so, or,
    // when it answers at once as Hearths that predate holding do, it has at
    // least taken the reply rather than asked for it again. Its dialer would
    // find Hearth on its next pass anyway.
    if (
      paired &&
      !woken &&
      !("reason" in answered) &&
      (answered.saved || (!answered.held && !answered.response.pairing))
    ) {
      woken = true
      if (input.wakeDials) {
        yield* input.wakeDials.pipe(Effect.withSpan("RelayJoin.wakeDials"))
      }
    }
    if ("reason" in answered) {
      report({ kind: "unreachable", reason: answered.reason })
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS)
    } else if (answered.response.status === "pending") {
      saved = yield* invite(input, saved, answered.response)
      if (!waiting) {
        report({
          confirmUrl: relayJoinConfirmUrl(link.hearthOrigin, saved.joinId),
          kind: "waiting",
        })
      }
      waiting = true
      delay = ANNOUNCE_INTERVAL_MS
      // Someone confirmed it, and Hearth pairs through the announcements.
      const pairing: RelayJoinResponse["pairing"] = answered.response.pairing
      if (
        pairing &&
        (!paired || paired.expiresAt - Date.now() < PAIRED_RENEW_MS)
      ) {
        paired = yield* pairThroughAnnouncements(input, pairing)
        // Answer at once rather than at the next announcement.
        continue
      }
    } else {
      return yield* finish(input, saved, answered.response.status, report)
    }
    yield* Effect.sleep(
      Math.min(
        "held" in answered && answered.held ? HELD_GAP_MS : delay,
        Math.max(0, saved.expiresAt - Date.now())
      )
    )
  }
})

// The saved join, saving it the first time. Its expiry is capped once, when
// the Relay first sees it, and kept.
const prepareJoin = Effect.fn("RelayJoin.prepare")(function* (
  input: RelayJoinInput
) {
  const { link, state } = input
  const joinId = relayJoinId(link.secret)
  const key = `${JOIN_METADATA_PREFIX}${joinId}`
  const existing = Option.getOrNull(
    decodeSavedJoin((yield* state.getMetadata(key)) ?? "")
  )
  // Hearth's address may be corrected; who may pair and until when may not.
  const saved: SavedJoin = existing
    ? { ...existing, hearthOrigin: link.hearthOrigin }
    : {
        clientId: null,
        envelope: null,
        expiresAt: Date.now() + RELAY_JOIN_LIFETIME_MS,
        hearthOrigin: link.hearthOrigin,
        joinId,
        outcome: null,
      }
  if (!existing || existing.hearthOrigin !== link.hearthOrigin) {
    yield* state.setMetadata(key, JSON.stringify(saved))
  }
  return saved
})

// Pairs with the request Hearth's answer carried, as the Relay would one
// Hearth sent it, and saves where to dial Hearth. A request that comes again,
// as after a restart, gets the same answer for the client it paired.
const pairThroughAnnouncements = Effect.fn("RelayJoin.pair")(function* (
  input: RelayJoinInput,
  pairing: NonNullable<RelayJoinResponse["pairing"]>
) {
  const request = yield* decodePairingRequest(pairing.request)
  const response = yield* pairHearth({
    bootstrapToken: input.config.bootstrapToken,
    identity: input.identity,
    request,
    state: input.state,
  })
  yield* saveControlDial(input.state, response.clientId, pairing.dialUrl)
  return response
})

// Makes the join's one invitation once Hearth names its client, for that
// client only, lasting no longer than either side allows.
const invite = Effect.fnUntraced(function* (
  input: RelayJoinInput,
  saved: SavedJoin,
  response: RelayJoinResponse
) {
  if (!response.clientId || response.expiresAt === null) {
    return yield* new RelayJoinError({
      reason: "Hearth didn't say which of its clients may pair",
    })
  }
  if (saved.clientId !== null && saved.clientId !== response.clientId) {
    return yield* new RelayJoinError({
      reason: "Hearth named another client for this join",
    })
  }
  const next: SavedJoin =
    saved.clientId !== null
      ? saved
      : {
          ...saved,
          clientId: response.clientId,
          expiresAt: Math.min(saved.expiresAt, response.expiresAt),
        }
  // Saved first, so a restart between the two finds the client and makes
  // the invitation then.
  if (next !== saved) {
    yield* input.state.setMetadata(
      `${JOIN_METADATA_PREFIX}${saved.joinId}`,
      JSON.stringify(next)
    )
  }
  if (!(yield* input.state.findInvitationById(saved.joinId))) {
    yield* createPairingInvitation({
      config: input.config,
      identity: input.identity,
      join: {
        clientId: response.clientId,
        expiresAt: next.expiresAt,
        invitationId: saved.joinId,
      },
      role: "full_access",
      state: input.state,
      tls: input.tls,
      token: relayJoinInvitationToken(input.link.secret),
    })
  }
  return next
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

// A response's body, read no further than `limit` bytes: null when it's
// longer. Anyone between the Relay and a plain-HTTP Hearth can answer, and
// the answer is only checked once it's read.
async function readLimitedText(
  response: Response,
  limit: number
): Promise<string | null> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel()
    return null
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

// One announcement. Fails with why Hearth couldn't be asked, or answered
// in a way that can't be trusted, so the caller tries again later.
function announce(
  link: RelayJoinLink,
  joinId: string,
  envelope: RelayJoinEnvelope,
  paired: typeof RelayJoinPairingResponseSchema.Type | null,
  // How long Hearth may hold it for news; 0 for an answer at once.
  holdMs: number,
  // Whether the Relay heard that Hearth saved it.
  heardSaved: boolean
) {
  const nonce = randomBytes(32).toString("base64url")
  const unsigned = { envelope, joinId, nonce, version: 1 as const }
  const body = JSON.stringify({
    ...unsigned,
    features: JOIN_FEATURES,
    mac: createHmac("sha256", link.secret)
      .update(relayJoinAnnouncementTranscript(unsigned))
      .digest("base64url"),
    ...(paired ? { pairing: paired } : {}),
  })
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(
        new URL("/api/relays/join", link.hearthOrigin),
        {
          body,
          headers: {
            "content-type": "application/json",
            ...(holdMs > 0 ? { [relayJoinHoldHeader]: String(holdMs) } : {}),
            ...(heardSaved ? { [relayJoinSavedHeader]: "1" } : {}),
          },
          method: "POST",
          // Never somewhere else, and never down to plain HTTP.
          redirect: "error",
          // A held announcement gets its usual time on top of the hold:
          // Hearth counts the hold from when it starts on it, which can be
          // later than when it was sent.
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(holdMs + REQUEST_TIMEOUT_MS),
          ]),
        }
      )
      const text = await readLimitedText(response, MAX_RESPONSE_BYTES)
      if (text === null) throw new Error("Hearth's answer was too large")
      return {
        held: response.headers.get(relayJoinHeldHeader) === "1",
        ok: response.ok,
        saved: response.headers.get(relayJoinSavedHeader) === "1",
        status: response.status,
        text,
      }
    },
    catch: (cause) =>
      new RelayJoinError({
        reason: `Hearth didn't answer: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap(({ held, ok, saved, status, text }) => {
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
      const { mac, ...response } = answer.value
      const expected = createHmac("sha256", link.secret)
        .update(relayJoinResponseTranscript({ ...response, joinId, nonce }))
        .digest()
      const actual = Buffer.from(mac, "base64url")
      return expected.length === actual.length &&
        timingSafeEqual(expected, actual)
        ? Effect.succeed({ held, response: answer.value, saved })
        : Effect.fail(
            new RelayJoinError({
              reason: "Hearth's answer didn't prove it holds the join",
            })
          )
    })
  )
}

/** A line for the log or terminal about how joining is going. */
export function describeRelayJoinEvent(
  event: RelayJoinEvent,
  hearthOrigin: string
): string {
  switch (event.kind) {
    case "started":
      return `Joining ${hearthOrigin} as ${event.fingerprint}`
    case "insecure":
      return "Hearth's address is plain HTTP; joining relies on the network between the two machines."
    case "waiting":
      return `Confirm this Relay in Hearth: ${event.confirmUrl}`
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
