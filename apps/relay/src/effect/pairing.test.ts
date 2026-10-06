import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  relayPairingRequestTranscript,
  relayPairingResponseTranscript,
} from "@workspace/contracts"

import { loadConfig } from "../config.js"
import type { RelayPairingError, RelayStateError } from "./errors.js"
import { loadOrCreateRelayIdentity } from "./identity.js"
import {
  createPairingInvitation,
  decodePairingUri,
  initializePairing,
  pairHearth,
} from "./pairing.js"
import { makeRelayStateLayer, RelayStateStore } from "./state.js"
import type { PairingInvitationBundle, PairingRequest } from "./pairing.js"

describe("Relay pairing", () => {
  it.effect("proves both identities and consumes its invitation", () =>
    withRelayState((directory) =>
      Effect.gen(function* () {
        const config = loadConfig({
          KILN_RELAY_DATA_DIR: directory,
          KILN_RELAY_HOST: "relay.test",
          KILN_RELAY_NAME: "Pairing Relay",
          NODE_ENV: "development",
        })
        const state = yield* RelayStateStore
        const identity = yield* loadOrCreateRelayIdentity(config)
        const invitation = yield* createPairingInvitation({
          config,
          identity,
          role: "read_only",
          state,
          tls: null,
        })
        const decodedUri = decodePairingUri(invitation.uri)
        assert.strictEqual(decodedUri.relayFingerprint, identity.fingerprint)
        assert.strictEqual(
          decodedUri.controlEndpoint,
          "ws://relay.test:4100/v1/socket"
        )

        const hearthKeys = ed25519Keys()
        const request = signedPairingRequest(invitation, hearthKeys)
        const response = yield* pairHearth({ identity, request, state })
        assert.strictEqual(response.role, "read_only")
        assert.isFalse(response.actions.includes("instance.power.start"))
        assert.isTrue(response.actions.includes("instance.console.read"))
        assert.isTrue(
          verify(
            null,
            Buffer.from(relayPairingResponseTranscript(response)),
            identity.publicKeyPem,
            Buffer.from(response.signature, "base64url")
          )
        )

        const secondAttempt = yield* pairHearth({ identity, request, state })
        assert.strictEqual(secondAttempt.clientId, response.clientId)
        assert.isTrue(
          verify(
            null,
            Buffer.from(relayPairingResponseTranscript(secondAttempt)),
            identity.publicKeyPem,
            Buffer.from(secondAttempt.signature, "base64url")
          )
        )

        const repairInvitation = yield* createPairingInvitation({
          config,
          identity,
          role: "full_access",
          state,
          tls: null,
        })
        const repaired = yield* pairHearth({
          identity,
          request: signedPairingRequest(repairInvitation, hearthKeys),
          state,
        })
        assert.strictEqual(repaired.clientId, response.clientId)
        assert.strictEqual(repaired.role, "full_access")
        assert.isTrue(
          (yield* state.findClientById(repaired.clientId))?.actions.includes(
            "instance.power.start"
          )
        )
      })
    )
  )

  it.effect("rejects a wrong token or a forged Hearth signature", () =>
    withRelayState((directory) =>
      Effect.gen(function* () {
        const config = loadConfig({
          KILN_RELAY_DATA_DIR: directory,
          KILN_RELAY_HOST: "relay.test",
          NODE_ENV: "development",
        })
        const state = yield* RelayStateStore
        const identity = yield* loadOrCreateRelayIdentity(config)
        const invitation = yield* createPairingInvitation({
          config,
          identity,
          role: "full_access",
          state,
          tls: null,
        })
        const hearthKeys = ed25519Keys()

        const wrongToken = yield* pairingFailureCode(
          pairHearth({
            identity,
            request: signedPairingRequest(
              { ...invitation, token: randomBytes(32).toString("base64url") },
              hearthKeys
            ),
            state,
          })
        )
        assert.strictEqual(wrongToken, "invalid_or_expired_invitation")

        const forged = yield* pairingFailureCode(
          pairHearth({
            identity,
            request: {
              ...signedPairingRequest(invitation, ed25519Keys()),
              publicKeyPem: hearthKeys.publicKey,
            },
            state,
          })
        )
        assert.strictEqual(forged, "invalid_client_signature")
        assert.lengthOf(yield* state.listClients(), 0)
        assert.isNotNull(
          yield* state.findActiveInvitation(
            invitation.envelope.invitationId,
            Date.now()
          )
        )
      })
    )
  )

  it.live("advertises Coolify's public edge instead of its private port", () =>
    withRelayState((directory) =>
      Effect.gen(function* () {
        const config = loadConfig({
          KILN_RELAY_DATA_DIR: directory,
          KILN_RELAY_HOST: "relay.example.com",
          KILN_RELAY_NAME: "Coolify Relay",
          KILN_RELAY_PROXY: "coolify",
          SERVICE_URL_KILN_RELAY_4100: "https://relay.example.com:4100",
          NODE_ENV: "production",
        })
        const state = yield* RelayStateStore
        const identity = yield* loadOrCreateRelayIdentity(config)
        const invitation = yield* createPairingInvitation({
          config,
          identity,
          role: "full_access",
          state,
          tls: null,
        })
        const decodedUri = decodePairingUri(invitation.uri)

        assert.strictEqual(
          decodedUri.browserOrigin,
          "https://relay.example.com"
        )
        assert.strictEqual(
          decodedUri.controlEndpoint,
          "wss://relay.example.com/v1/socket"
        )
      })
    )
  )

  it.live(
    "replaces an automatic invitation when its bootstrap token rotates",
    () =>
      withRelayState((directory) =>
        Effect.gen(function* () {
          const firstConfig = loadConfig({
            KILN_RELAY_BOOTSTRAP_TOKEN: "a".repeat(32),
            KILN_RELAY_DATA_DIR: directory,
            KILN_RELAY_HOST: "relay.test",
            KILN_RELAY_NAME: "Pairing Relay",
            NODE_ENV: "development",
          })
          const state = yield* RelayStateStore
          const identity = yield* loadOrCreateRelayIdentity(firstConfig)
          const first = yield* initializePairing({
            config: firstConfig,
            identity,
            state,
            tls: null,
          })
          assert.strictEqual(first.invitation?.token, "a".repeat(32))

          const secondConfig = loadConfig({
            KILN_RELAY_BOOTSTRAP_TOKEN: "b".repeat(32),
            KILN_RELAY_DATA_DIR: directory,
            KILN_RELAY_HOST: "relay.test",
            KILN_RELAY_NAME: "Pairing Relay",
            NODE_ENV: "development",
          })
          const second = yield* initializePairing({
            config: secondConfig,
            identity,
            state,
            tls: null,
          })
          assert.strictEqual(second.invitation?.token, "b".repeat(32))
          assert.lengthOf(yield* state.listInvitations(Date.now()), 1)

          const rotatedBack = yield* initializePairing({
            config: firstConfig,
            identity,
            state,
            tls: null,
          })
          assert.strictEqual(rotatedBack.invitation?.token, "a".repeat(32))
          assert.lengthOf(yield* state.listInvitations(Date.now()), 1)
        })
      )
  )
})

/** Runs `use` against a fresh Relay data directory and SQLite state store. */
function withRelayState<A, E>(
  use: (directory: string) => Effect.Effect<A, E, RelayStateStore>
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "kiln-relay-pairing-"))),
    (directory) =>
      use(directory).pipe(
        Effect.provide(makeRelayStateLayer(join(directory, "relay.sqlite")))
      ),
    (directory) =>
      Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
  )
}

function pairingFailureCode<A, R>(
  effect: Effect.Effect<A, RelayPairingError | RelayStateError, R>
) {
  return effect.pipe(
    Effect.flip,
    Effect.map((error) =>
      error._tag === "RelayPairingError" ? error.code : error._tag
    )
  )
}

function ed25519Keys() {
  return generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
}

function signedPairingRequest(
  invitation: PairingInvitationBundle,
  keys: { readonly privateKey: string; readonly publicKey: string }
): PairingRequest {
  const unsigned = {
    bootstrapProof: null,
    hearthName: "Hearth Test",
    hearthOrigin: "https://hearth.test",
    invitationId: invitation.envelope.invitationId,
    nonce: randomBytes(24).toString("base64url"),
    publicKeyPem: keys.publicKey,
    signature: "",
    token: invitation.token,
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
