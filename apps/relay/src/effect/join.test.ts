import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  RELAY_JOIN_LIFETIME_MS,
  type RelayJoinAnnouncement,
  type RelayJoinResponse,
  relayJoinAnnouncementTranscript,
  relayJoinResponseTranscript,
  relayPairingRequestTranscript,
} from "@workspace/contracts"

import { loadConfig } from "../config.js"
import {
  fingerprint,
  loadOrCreateRelayIdentity,
  type RelayIdentity,
} from "./identity.js"
import { relayJoinId, relayJoinInvitationToken, runRelayJoin } from "./join.js"
import { pairHearth, type PairingRequest } from "./pairing.js"
import { makeRelayStateLayer, RelayStateStore } from "./state.js"

const secret = "abcdefghijklmnopqrs2"
const joinId = relayJoinId(secret)

describe("Relay joining", () => {
  it.live(
    "makes one invitation, once Hearth names its client, that only that client can pair with",
    () =>
      withJoiningRelay((relay) =>
        Effect.scoped(
          Effect.gen(function* () {
            const hearthKeys = ed25519Keys()
            const clientId = fingerprint(hearthKeys.publicKey)
            const hearth = yield* fakeHearth([
              // A join can't last longer than a join does.
              {
                clientId,
                expiresAt: Date.now() + 24 * 60 * 60_000,
                status: "pending",
              },
              { clientId: null, expiresAt: null, status: "paired" },
            ])
            const events: Array<string> = []

            const outcome = yield* runRelayJoin(
              { ...relay, link: { hearthOrigin: hearth.origin, secret } },
              (event) => events.push(event.kind)
            )

            assert.strictEqual(outcome, "paired")
            assert.deepStrictEqual(events, [
              "started",
              "insecure",
              "waiting",
              "finished",
            ])
            assert.strictEqual(
              hearth.announcements[0]?.envelope.invitationId,
              joinId
            )
            const invitation = yield* relay.state.findInvitationById(joinId)
            assert.strictEqual(invitation?.clientId, clientId)
            assert.isAtMost(
              invitation?.expiresAt ?? Infinity,
              Date.now() + RELAY_JOIN_LIFETIME_MS
            )

            // Another key with the token, then the join's own.
            const stranger = yield* Effect.flip(
              pairHearth({
                identity: relay.identity,
                request: joinPairingRequest(ed25519Keys()),
                state: relay.state,
              })
            )
            assert.strictEqual(
              stranger._tag === "RelayPairingError"
                ? stranger.code
                : stranger._tag,
              "invalid_or_expired_invitation"
            )
            const paired = yield* pairHearth({
              identity: relay.identity,
              request: joinPairingRequest(hearthKeys),
              state: relay.state,
            })
            assert.strictEqual(paired.clientId, clientId)
            assert.strictEqual(paired.role, "full_access")
          })
        )
      ),
    // It announces again after its interval, to hear it's paired.
    15_000
  )

  it.live("trusts no answer that doesn't prove the join", () =>
    withJoiningRelay((relay) =>
      Effect.scoped(
        Effect.gen(function* () {
          const hearth = yield* fakeHearth(
            [
              {
                clientId: fingerprint(ed25519Keys().publicKey),
                expiresAt: Date.now() + 60_000,
                status: "pending",
              },
            ],
            { forge: true }
          )

          yield* runRelayJoin(
            { ...relay, link: { hearthOrigin: hearth.origin, secret } },
            () => {}
          ).pipe(Effect.timeout(1_000), Effect.ignore)

          assert.isAbove(hearth.announcements.length, 0)
          assert.isNull(yield* relay.state.findInvitationById(joinId))
        })
      )
    )
  )

  it.live("ends with its join, and never outlives it after a restart", () =>
    withJoiningRelay((relay) =>
      Effect.scoped(
        Effect.gen(function* () {
          const hearthKeys = ed25519Keys()
          const hearth = yield* fakeHearth([
            {
              clientId: fingerprint(hearthKeys.publicKey),
              expiresAt: Date.now() + 1_500,
              status: "pending",
            },
          ])
          const run = runRelayJoin(
            { ...relay, link: { hearthOrigin: hearth.origin, secret } },
            () => {}
          )

          assert.strictEqual(yield* run, "expired")
          // Its invitation can't pair anyone now, and starting again
          // doesn't bring the join back.
          assert.isNull(
            yield* relay.state.findActiveInvitation(joinId, Date.now())
          )
          assert.strictEqual(yield* run, "expired")
        })
      )
    )
  )
})

// A Relay to join with, on a fresh data directory and state store.
function withJoiningRelay<A, E>(
  use: (relay: {
    readonly config: ReturnType<typeof loadConfig>
    readonly identity: RelayIdentity
    readonly state: RelayStateStore["Service"]
    readonly tls: null
  }) => Effect.Effect<A, E>
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "kiln-relay-join-"))),
    (directory) =>
      Effect.gen(function* () {
        const config = loadConfig({
          KILN_RELAY_DATA_DIR: directory,
          KILN_RELAY_HOST: "relay.test",
          KILN_RELAY_TLS_MODE: "managed",
          NODE_ENV: "development",
        })
        const state = yield* RelayStateStore
        const identity = yield* loadOrCreateRelayIdentity(config)
        return yield* use({ config, identity, state, tls: null })
      }).pipe(
        Effect.provide(makeRelayStateLayer(join(directory, "relay.sqlite")))
      ),
    (directory) =>
      Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
  )
}

// Hearth's join endpoint, giving each answer in turn and repeating the
// last: MAC'd with the join's code, or with another key when forging.
function fakeHearth(
  answers: ReadonlyArray<Omit<RelayJoinResponse, "mac">>,
  options: { readonly forge?: boolean } = {}
) {
  const announcements: Array<RelayJoinAnnouncement> = []
  let asked = 0
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const server: Server = createServer((request, response) => {
        const chunks: Array<Buffer> = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
          let announcement: RelayJoinAnnouncement
          try {
            announcement = JSON.parse(
              Buffer.concat(chunks).toString("utf8")
            ) as RelayJoinAnnouncement
          } catch {
            // A request the Relay abandoned as its join ended.
            response.destroy()
            return
          }
          const expected = createHmac("sha256", secret)
            .update(relayJoinAnnouncementTranscript(announcement))
            .digest("base64url")
          if (announcement.mac === expected) announcements.push(announcement)
          const answer = answers[Math.min(asked, answers.length - 1)]
          asked += 1
          if (!answer) throw new Error("The fake Hearth has no answers")
          response.setHeader("content-type", "application/json")
          response.end(
            JSON.stringify({
              ...answer,
              mac: createHmac("sha256", options.forge ? "not-the-code" : secret)
                .update(
                  relayJoinResponseTranscript({
                    ...answer,
                    joinId: announcement.joinId,
                    nonce: announcement.nonce,
                  })
                )
                .digest("base64url"),
            })
          )
        })
      })
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      return server
    }),
    (server) =>
      Effect.promise(
        () => new Promise<void>((resolve) => server.close(() => resolve()))
      )
  ).pipe(
    Effect.map((server) => ({
      announcements,
      origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    }))
  )
}

function ed25519Keys() {
  return generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
}

// Hearth's pairing request for the join, with the join's derived token.
function joinPairingRequest(keys: {
  readonly privateKey: string
  readonly publicKey: string
}): PairingRequest {
  const unsigned = {
    bootstrapProof: null,
    hearthName: "Hearth Test",
    hearthOrigin: "https://hearth.test",
    invitationId: joinId,
    nonce: randomBytes(24).toString("base64url"),
    publicKeyPem: keys.publicKey,
    signature: "",
    token: relayJoinInvitationToken(secret),
    version: 1 as const,
  }
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(relayPairingRequestTranscript(unsigned)),
      keys.privateKey
    ).toString("base64url"),
  }
}
