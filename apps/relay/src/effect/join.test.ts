import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

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

  it.effect(
    "keeps waiting after pairing until Hearth says it saved the Relay",
    () =>
      withJoiningRelay((relay) =>
        Effect.scoped(
          Effect.gen(function* () {
            const hearthKeys = ed25519Keys()
            const answers: Array<Omit<RelayJoinResponse, "mac">> = [
              {
                clientId: fingerprint(hearthKeys.publicKey),
                expiresAt: Date.now() + 60_000,
                status: "pending",
              },
            ]
            const hearth = yield* fakeHearth(answers)
            const events: Array<string> = []
            const joining = yield* runRelayJoin(
              { ...relay, link: { hearthOrigin: hearth.origin, secret } },
              (event) => events.push(event.kind)
            ).pipe(Effect.forkChild)
            yield* advanceUntil(() => events.includes("waiting"))

            // Hearth pairs, then fails to save the Relay, so it still
            // answers that the join is pending.
            yield* pairHearth({
              identity: relay.identity,
              request: joinPairingRequest(hearthKeys),
              state: relay.state,
            })
            const asked = hearth.asked()
            yield* advanceUntil(() => hearth.asked() > asked)
            assert.notInclude(events, "finished")

            answers.push({ clientId: null, expiresAt: null, status: "paired" })
            yield* advanceUntil(() => events.includes("finished"))
            assert.strictEqual(yield* Fiber.join(joining), "paired")
          })
        )
      )
  )

  it.effect(
    "keeps the client it paired whatever Hearth later says of the join",
    () =>
      withJoiningRelay((relay) =>
        Effect.scoped(
          Effect.gen(function* () {
            const hearthKeys = ed25519Keys()
            const answers: Array<Omit<RelayJoinResponse, "mac">> = [
              {
                clientId: fingerprint(hearthKeys.publicKey),
                expiresAt: Date.now() + 60_000,
                status: "pending",
              },
            ]
            const hearth = yield* fakeHearth(answers)
            const events: Array<string> = []
            const joining = yield* runRelayJoin(
              { ...relay, link: { hearthOrigin: hearth.origin, secret } },
              (event) => events.push(event.kind)
            ).pipe(Effect.forkChild)
            yield* advanceUntil(() => events.includes("waiting"))
            const paired = yield* pairHearth({
              identity: relay.identity,
              request: joinPairingRequest(hearthKeys),
              state: relay.state,
            })

            // Hearth may have saved it, or not; the Relay can't tell, and
            // revoking a client Hearth saved would lock Hearth out.
            answers.push({ clientId: null, expiresAt: null, status: "expired" })
            yield* advanceUntil(() => events.includes("finished"))
            assert.strictEqual(yield* Fiber.join(joining), "expired")
            const clients = yield* relay.state.listClients()
            assert.isTrue(
              clients.some((client) => client.id === paired.clientId)
            )
          })
        )
      )
  )

  it.effect(
    "announces itself as it first did after a restart, so Hearth still knows it",
    () =>
      withJoiningRelay((relay) =>
        Effect.scoped(
          Effect.gen(function* () {
            const hearth = yield* fakeHearth([
              {
                clientId: fingerprint(ed25519Keys().publicKey),
                expiresAt: Date.now() + 60_000,
                status: "pending",
              },
            ])
            const run = (config: typeof relay.config) => {
              const events: Array<string> = []
              return runRelayJoin(
                {
                  ...relay,
                  config,
                  link: { hearthOrigin: hearth.origin, secret },
                },
                (event) => events.push(event.kind)
              ).pipe(
                Effect.forkChild,
                Effect.tap(() => advanceUntil(() => events.includes("waiting")))
              )
            }
            yield* Fiber.interrupt(yield* run(relay.config))

            // Restarted with the installation ID Hearth gave it.
            const asked = hearth.announcements.length
            yield* run({ ...relay.config, installationId: "hearth-install" })
            yield* advanceUntil(() => hearth.announcements.length > asked)
            assert.deepStrictEqual(
              hearth.announcements.at(-1)?.envelope,
              hearth.announcements[0]?.envelope
            )
          })
        )
      )
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

  it.live(
    "stops reading an answer once it's longer than any Hearth sends",
    () =>
      withJoiningRelay((relay) =>
        Effect.scoped(
          Effect.gen(function* () {
            // Something between the Relay and a plain-HTTP Hearth answers
            // without end.
            let sent = 0
            const server = yield* Effect.acquireRelease(
              Effect.promise(async () => {
                const server: Server = createServer((_request, response) => {
                  const chunk = Buffer.alloc(64 * 1024, "a")
                  const write = () => {
                    while (sent < 64 * 1024 * 1024) {
                      sent += chunk.byteLength
                      if (!response.write(chunk)) {
                        response.once("drain", write)
                        return
                      }
                    }
                    response.end()
                  }
                  response.on("close", () => response.removeAllListeners())
                  write()
                })
                server.listen(0, "127.0.0.1")
                await once(server, "listening")
                return server
              }),
              (server) =>
                Effect.promise(
                  () =>
                    new Promise<void>((resolve) => {
                      server.closeAllConnections()
                      server.close(() => resolve())
                    })
                )
            )
            const reasons: Array<string> = []
            yield* runRelayJoin(
              {
                ...relay,
                link: {
                  hearthOrigin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
                  secret,
                },
              },
              (event) => {
                if (event.kind === "unreachable") reasons.push(event.reason)
              }
            ).pipe(Effect.timeout(1_000), Effect.ignore)

            assert.include(reasons[0] ?? "", "too large")
            assert.isBelow(sent, 8 * 1024 * 1024)
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

  it.live("joins only over the Relay's own HTTPS", () =>
    withJoiningRelay(
      (relay) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            runRelayJoin(
              {
                ...relay,
                link: { hearthOrigin: "https://kiln.example.test", secret },
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

// Moves the test clock a second at a time, letting the Relay's requests to
// the fake Hearth land in between, until `done` holds.
function advanceUntil(done: () => boolean) {
  return Effect.gen(function* () {
    while (!done()) {
      yield* TestClock.adjust(1_000)
      yield* Effect.promise(
        () => new Promise((resolve) => setTimeout(resolve, 10))
      )
    }
  })
}

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
          const announcement = JSON.parse(
            Buffer.concat(chunks).toString("utf8")
          ) as RelayJoinAnnouncement
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
      // How many announcements Hearth has answered.
      asked: () => asked,
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
