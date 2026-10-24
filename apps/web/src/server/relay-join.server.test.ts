import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
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
