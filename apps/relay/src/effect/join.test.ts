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
  type RelayJoinStatus,
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
import { relayJoinInvitationToken, runRelayJoin } from "./join.js"
import { pairHearth, type PairingRequest } from "./pairing.js"
import { makeRelayStateLayer, RelayStateStore } from "./state.js"

const secret = randomBytes(32).toString("base64url")
const joinId = "0e0f6703-46db-4677-b84c-138997bc25a9"

describe("Relay joining", () => {
  it.live(
    "makes one invitation that only the join's Hearth key can pair with",
    () =>
      withJoiningRelay((relay) =>
        Effect.scoped(
          Effect.gen(function* () {
            const hearth = yield* fakeHearth({ answer: "paired" })
            const hearthKeys = ed25519Keys()
            const link = {
              clientId: fingerprint(hearthKeys.publicKey),
              // A link can't make a join last longer than a join does.
              expiresAt: Date.now() + 24 * 60 * 60_000,
              hearthOrigin: hearth.origin,
              joinId,
              secret,
            }

            const outcome = yield* runRelayJoin({ ...relay, link }, () => {})

            assert.strictEqual(outcome, "paired")
            const [announced] = hearth.announcements
            assert.isDefined(announced)
            assert.strictEqual(announced?.envelope.invitationId, joinId)
            assert.strictEqual(
              announced?.envelope.relayFingerprint,
              relay.identity.fingerprint
            )
            assert.isAtMost(
              announced?.envelope.expiresAt ?? Infinity,
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
            assert.strictEqual(paired.clientId, link.clientId)
            assert.strictEqual(paired.role, "full_access")
          })
        )
      )
  )

  it.live(
    "ignores answers that don't prove the join, and never outlives it",
    () =>
      withJoiningRelay((relay) =>
        Effect.scoped(
          Effect.gen(function* () {
            const hearth = yield* fakeHearth({ answer: "paired", forge: true })
            const hearthKeys = ed25519Keys()
            const link = {
              clientId: fingerprint(hearthKeys.publicKey),
              expiresAt: Date.now() + 1_500,
              hearthOrigin: hearth.origin,
              joinId,
              secret,
            }

            // Hearth "answers paired", but without the join's secret.
            assert.strictEqual(
              yield* runRelayJoin({ ...relay, link }, () => {}),
              "expired"
            )
            // Its invitation can't pair anyone now.
            assert.isNull(
              yield* relay.state.findActiveInvitation(joinId, Date.now())
            )

            // The same join from a link claiming more time is still over.
            assert.strictEqual(
              yield* runRelayJoin(
                {
                  ...relay,
                  link: { ...link, expiresAt: Date.now() + 10 * 60_000 },
                },
                () => {}
              ),
              "expired"
            )
          })
        )
      )
  )

  it.live("joins only over the Relay's own HTTPS", () =>
    withJoiningRelay(
      (relay) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            runRelayJoin(
              {
                ...relay,
                link: {
                  clientId: "c".repeat(43),
                  expiresAt: Date.now() + 60_000,
                  hearthOrigin: "https://kiln.example.test",
                  joinId,
                  secret,
                },
              },
              () => {}
            )
          )
          assert.include(failure.message, "HTTPS")
        }),
      { KILN_RELAY_TLS_MODE: "development" }
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
  }) => Effect.Effect<A, E>,
  environment: Record<string, string> = {}
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
          ...environment,
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

// Hearth's join endpoint, answering every announcement the same way: with
// the join's secret, or with a forged MAC.
function fakeHearth(options: {
  readonly answer: RelayJoinStatus
  readonly forge?: boolean
}) {
  const announcements: Array<RelayJoinAnnouncement> = []
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const server: Server = createServer((request, response) => {
        const chunks: Array<Buffer> = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
          const announcement = JSON.parse(
            Buffer.concat(chunks).toString("utf8")
          ) as RelayJoinAnnouncement
          const expected = createHmac("sha256", secret)
            .update(relayJoinAnnouncementTranscript(announcement))
            .digest("base64url")
          if (announcement.mac === expected) announcements.push(announcement)
          response.setHeader("content-type", "application/json")
          response.end(
            JSON.stringify({
              mac: createHmac(
                "sha256",
                options.forge ? "not-the-secret" : secret
              )
                .update(
                  relayJoinResponseTranscript({
                    joinId: announcement.joinId,
                    nonce: announcement.nonce,
                    status: options.answer,
                  })
                )
                .digest("base64url"),
              status: options.answer,
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
