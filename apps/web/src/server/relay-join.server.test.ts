import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"
import {
  type RelayJoinEnvelope,
  relayJoinAnnouncementTranscript,
  relayJoinResponseTranscript,
} from "@workspace/contracts"

import {
  answerRelayJoinAnnouncement,
  confirmRelayJoinEffect,
  openRelayJoinEffect,
  refreshRelayJoinEffect,
  relayJoinViewEffect,
} from "@/server/relay-join.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { deletePersistedRelayEffect } from "@/lib/relay-registry"
import { insertRelay } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"j".repeat(32)}`)

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// A Relay's announcement for a join, as effect/join.ts on the Relay sends it.
function relayEnvelope(
  joinId: string,
  overrides: Partial<RelayJoinEnvelope> = {}
): RelayJoinEnvelope {
  const { publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  })
  return {
    browserOrigin: "https://relay.test:4100",
    caCertificatePem: null,
    controlEndpoint: "wss://relay.test:4100/v1/socket",
    installation: { fixed: false, id: null, replace: true },
    invitationId: joinId,
    relayBuild: "1.0.0",
    relayFingerprint: createHash("sha256")
      .update(
        createPublicKey(publicKey).export({ format: "der", type: "spki" })
      )
      .digest("base64url"),
    relayName: "Relay",
    relayPublicKeyPem: publicKey,
    ...overrides,
  }
}

// Posts an announcement to the join endpoint, keyed by `secret`.
function announce(
  joinId: string,
  secret: string,
  envelope: RelayJoinEnvelope,
  address: string
) {
  const nonce = randomBytes(32).toString("base64url")
  const unsigned = { envelope, joinId, nonce, version: 1 as const }
  const request = new Request("https://hearth.test/api/relays/join", {
    body: JSON.stringify({
      ...unsigned,
      mac: createHmac("sha256", secret)
        .update(relayJoinAnnouncementTranscript(unsigned))
        .digest("base64url"),
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
  return answerRelayJoinAnnouncement(request, address).pipe(
    Effect.flatMap((response) =>
      Effect.promise(async () => ({
        body: (await response.json()) as {
          clientId?: string | null
          expiresAt?: number | null
          mac?: string
          status?: string
        },
        status: response.status,
      }))
    ),
    Effect.map((answer) => ({
      ...answer,
      // Whether the answer proves Hearth holds the join.
      proven:
        answer.body.status !== undefined &&
        answer.body.mac ===
          createHmac("sha256", secret)
            .update(
              relayJoinResponseTranscript({
                clientId: answer.body.clientId ?? null,
                expiresAt: answer.body.expiresAt ?? null,
                joinId,
                nonce,
                status: answer.body.status as "pending",
              })
            )
            .digest("base64url"),
    }))
  )
}

describeMysql("Relay joins", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "accept one Relay per join, proven by its secret, and tell it where it stands",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const join = yield* openRelayJoinEffect("owner")
          assert.match(join.secret ?? "", /^[a-z2-7]{20}$/u)
          const secret = join.secret ?? ""
          const envelope = relayEnvelope(join.id)

          const forged = yield* announce(
            join.id,
            randomBytes(32).toString("base64url"),
            envelope,
            "203.0.113.1"
          )
          assert.strictEqual(forged.status, 403)

          const first = yield* announce(
            join.id,
            secret,
            envelope,
            "203.0.113.1"
          )
          assert.deepInclude(first, { proven: true, status: 200 })
          assert.strictEqual(first.body.status, "pending")
          // Naming the one Hearth client the Relay may let pair.
          assert.match(first.body.clientId ?? "", /^[A-Za-z\d_-]{43}$/u)
          assert.strictEqual(first.body.expiresAt, join.expiresAt)
          // The same Relay asking again.
          const again = yield* announce(
            join.id,
            secret,
            envelope,
            "203.0.113.1"
          )
          assert.strictEqual(again.body.status, "pending")
          // Another Relay with the same link.
          const other = yield* announce(
            join.id,
            secret,
            relayEnvelope(join.id),
            "203.0.113.1"
          )
          assert.deepInclude(other, { proven: true })
          assert.strictEqual(other.body.status, "claimed")

          const view = yield* relayJoinViewEffect("owner", join.id)
          assert.strictEqual(view.state, "announced")
          assert.strictEqual(
            view.announcement?.relayFingerprint,
            envelope.relayFingerprint
          )

          const oversized = yield* answerRelayJoinAnnouncement(
            new Request("https://hearth.test/api/relays/join", {
              body: "x".repeat(32 * 1024),
              method: "POST",
            }),
            "203.0.113.1"
          )
          assert.strictEqual(oversized.status, 413)
        })
    )

    it.effect(
      "turn away a Relay without its own HTTPS, and tell a refreshed join's Relay it expired",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const join = yield* openRelayJoinEffect("owner")
          const secret = join.secret ?? ""

          const plain = yield* announce(
            join.id,
            secret,
            relayEnvelope(join.id, {
              browserOrigin: "http://relay.test:4100",
              controlEndpoint: "ws://relay.test:4100/v1/socket",
            }),
            "203.0.113.2"
          )
          assert.strictEqual(plain.status, 422)
          assert.strictEqual(
            (yield* relayJoinViewEffect("owner", join.id)).state,
            "waiting"
          )

          const refreshed = yield* refreshRelayJoinEffect("owner", join.id)
          assert.notStrictEqual(refreshed.id, join.id)
          const stale = yield* announce(
            join.id,
            secret,
            relayEnvelope(join.id),
            "203.0.113.2"
          )
          assert.deepInclude(stale, { proven: true })
          assert.strictEqual(stale.body.status, "expired")
          // Opening the dialog again shows the new command.
          assert.strictEqual(
            (yield* openRelayJoinEffect("owner")).id,
            refreshed.id
          )
        })
    )

    it.effect(
      "won't add a Relay where Hearth already has another, and says which",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          // The machine set up again: a new identity at the old address.
          yield* insertRelay("old-relay", {
            hostname: "relay.test",
            name: "K100",
            port: 4100,
          })
          const join = yield* openRelayJoinEffect("owner")
          yield* announce(
            join.id,
            join.secret ?? "",
            relayEnvelope(join.id),
            "203.0.113.5"
          )

          const view = yield* relayJoinViewEffect("owner", join.id)
          assert.deepStrictEqual(view.announcement?.addressTakenBy, {
            id: "old-relay",
            name: "K100",
          })
          const refused = yield* Effect.flip(
            confirmRelayJoinEffect({
              canManageAnyRelay: true,
              envelopeDigest: view.announcement?.envelopeDigest ?? "",
              installation: "use",
              joinId: join.id,
              name: null,
              userId: "owner",
            })
          )
          assert.include(messageOf(refused), "K100 is already at")
          assert.strictEqual(
            (yield* relayJoinViewEffect("owner", join.id)).state,
            "announced"
          )
        })
    )

    it.effect(
      "let adding a Relay be tried again, or dropped for a new command, once it failed",
      () =>
        // Confirming starts the worker, which reads the real clock.
        TestClock.withLive(
          Effect.gen(function* () {
            yield* resetDatabase
            const join = yield* openRelayJoinEffect("owner")
            // At a closed port, so pairing with it fails at once.
            const envelope = relayEnvelope(join.id, {
              browserOrigin: "https://127.0.0.1:1",
              controlEndpoint: "wss://127.0.0.1:1/v1/socket",
            })
            yield* announce(join.id, join.secret ?? "", envelope, "203.0.113.6")
            const confirm = (joinId: string) =>
              Effect.gen(function* () {
                return yield* confirmRelayJoinEffect({
                  canManageAnyRelay: true,
                  envelopeDigest:
                    (yield* relayJoinViewEffect("owner", joinId)).announcement
                      ?.envelopeDigest ?? "",
                  installation: "use",
                  joinId,
                  name: null,
                  userId: "owner",
                })
              })
            const failure = (joinId: string) =>
              relayJoinViewEffect("owner", joinId).pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("100 millis"),
                  until: (view) => view.error !== null,
                }),
                Effect.timeout("4 seconds")
              )

            yield* confirm(join.id)
            assert.strictEqual((yield* failure(join.id)).state, "confirming")
            // Try again takes over at once: the stopped worker let go.
            assert.isNull((yield* confirm(join.id)).error)
            yield* failure(join.id)

            const next = yield* refreshRelayJoinEffect("owner", join.id)
            assert.notStrictEqual(next.id, join.id)
            assert.strictEqual(
              (yield* relayJoinViewEffect("owner", join.id)).state,
              "revoked"
            )
            // The same Relay can join with the new command.
            yield* announce(
              next.id,
              next.secret ?? "",
              { ...envelope, invitationId: next.id },
              "203.0.113.6"
            )
            assert.strictEqual((yield* confirm(next.id)).state, "confirming")
          })
        )
    )

    it.effect(
      "end a join still adding a Relay when that Relay is removed, so it can join again",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            yield* resetDatabase
            const join = yield* openRelayJoinEffect("owner")
            // A Relay Hearth has, at a closed port, so adding it stalls.
            const envelope = relayEnvelope(join.id, {
              browserOrigin: "https://127.0.0.1:1",
              controlEndpoint: "wss://127.0.0.1:1/v1/socket",
            })
            yield* insertRelay(envelope.relayFingerprint, {
              hostname: "127.0.0.1",
              port: 1,
            })
            yield* announce(join.id, join.secret ?? "", envelope, "203.0.113.8")
            const confirm = (joinId: string) =>
              Effect.gen(function* () {
                return yield* confirmRelayJoinEffect({
                  canManageAnyRelay: true,
                  envelopeDigest:
                    (yield* relayJoinViewEffect("owner", joinId)).announcement
                      ?.envelopeDigest ?? "",
                  installation: "keep",
                  joinId,
                  name: null,
                  userId: "owner",
                })
              })
            yield* confirm(join.id)

            yield* deletePersistedRelayEffect(envelope.relayFingerprint)
            assert.strictEqual(
              (yield* relayJoinViewEffect("owner", join.id)).state,
              "revoked"
            )
            const next = yield* openRelayJoinEffect("owner")
            assert.notStrictEqual(next.id, join.id)
            yield* announce(
              next.id,
              next.secret ?? "",
              { ...envelope, invitationId: next.id },
              "203.0.113.8"
            )
            assert.strictEqual((yield* confirm(next.id)).state, "confirming")
          })
        )
    )

    it.effect(
      "refuse an oversized announcement without reading all of it",
      () =>
        Effect.gen(function* () {
          const chunk = new Uint8Array(64 * 1024)
          let sent = 0
          const body = new ReadableStream<Uint8Array>({
            pull: (controller) => {
              sent += chunk.byteLength
              if (sent > 64 * 1024 * 1024) controller.close()
              else controller.enqueue(chunk)
            },
          })
          const response = yield* answerRelayJoinAnnouncement(
            new Request("https://hearth.test/api/relays/join", {
              body,
              // @ts-expect-error Node needs this for a streamed body.
              duplex: "half",
              method: "POST",
            }),
            "203.0.113.7"
          )
          assert.strictEqual(response.status, 413)
          assert.isBelow(sent, 1024 * 1024)
        })
    )

    it.effect("belong to whoever opened them", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const join = yield* openRelayJoinEffect("owner")
        const envelope = relayEnvelope(join.id)
        yield* announce(join.id, join.secret ?? "", envelope, "203.0.113.3")

        const seen = yield* Effect.flip(
          relayJoinViewEffect("stranger", join.id)
        )
        assert.strictEqual(messageOf(seen), "Join not found")
        const confirmed = yield* Effect.flip(
          confirmRelayJoinEffect({
            canManageAnyRelay: true,
            envelopeDigest:
              (yield* relayJoinViewEffect("owner", join.id)).announcement
                ?.envelopeDigest ?? "",
            installation: "use",
            joinId: join.id,
            name: null,
            userId: "stranger",
          })
        )
        assert.strictEqual(messageOf(confirmed), "Join not found")
        // Refreshing someone else's join only opens one of their own.
        const theirs = yield* refreshRelayJoinEffect("stranger", join.id)
        assert.notStrictEqual(theirs.id, join.id)
        assert.strictEqual(
          (yield* relayJoinViewEffect("owner", join.id)).state,
          "announced"
        )
      })
    )

    it.effect(
      "freeze what someone confirmed, and refuse other choices meanwhile",
      () =>
        // Confirming starts the worker, which reads the real clock.
        TestClock.withLive(
          Effect.gen(function* () {
            yield* resetDatabase
            const join = yield* openRelayJoinEffect("owner")
            const envelope = relayEnvelope(join.id)
            yield* announce(join.id, join.secret ?? "", envelope, "203.0.113.4")
            const digest =
              (yield* relayJoinViewEffect("owner", join.id)).announcement
                ?.envelopeDigest ?? ""
            const confirm = (name: string | null, digestUsed = digest) =>
              confirmRelayJoinEffect({
                canManageAnyRelay: true,
                envelopeDigest: digestUsed,
                installation: "use",
                joinId: join.id,
                name,
                userId: "owner",
              })

            const changed = yield* Effect.flip(confirm("Forge", "0".repeat(64)))
            assert.strictEqual(
              messageOf(changed),
              "The Relay changed; review it again"
            )

            const confirming = yield* confirm("Forge")
            assert.strictEqual(confirming.state, "confirming")
            assert.deepStrictEqual(confirming.intent, {
              installation: "use",
              name: "Forge",
            })
            const otherName = yield* Effect.flip(confirm("Anvil"))
            assert.strictEqual(
              messageOf(otherName),
              "This Relay is already being added with other choices"
            )
            // A command can't be swapped out from under it.
            const refreshed = yield* Effect.flip(
              refreshRelayJoinEffect("owner", join.id)
            )
            assert.include(messageOf(refreshed), "being added")
          })
        )
    )
  })
})
