/**
 * What a platform backup carries besides Hearth's database, so the backup
 * and its recovery code alone restore Kiln on a new machine: the
 * installation's record with its secrets, and the platform Relay's identity
 * and the Hearths it trusts, so the restored Hearth finds the same Relay and
 * reconnects to it without pairing again.
 *
 * It travels inside a platform backup's encryption, in format 2 and later.
 * The format is read by later Kiln versions; change it only by adding to it.
 */
import { Effect, Schema } from "effect"

import type { RelayConfig } from "./config.js"
import { readRelayIdentityMaterial } from "./effect/identity.js"
import type { RelayStateStore } from "./effect/state.js"
import { readRelayCertificateAuthority } from "./effect/tls.js"
import { PlatformStateSchema, readPlatformState } from "./platform-state.js"

const PlatformRecoveryClientSchema = Schema.Struct({
  actions: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  id: Schema.String,
  invitationId: Schema.String,
  name: Schema.String,
  origins: Schema.Array(Schema.String),
  publicKey: Schema.String,
  role: Schema.Literals(["custom", "full_access", "read_only"]),
  sourceCidrs: Schema.Array(Schema.String),
})

export const PlatformRecoverySchema = Schema.Struct({
  installation: PlatformStateSchema,
  relay: Schema.Struct({
    /** The Hearths that may connect to the Relay, unrevoked. */
    clients: Schema.Array(PlatformRecoveryClientSchema),
    identity: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      privateKeyPem: Schema.String,
      publicKeyPem: Schema.String,
    }),
    /**
     * The authority its TLS certificates come from, which Hearth pins; null
     * when a proxy or the operator's own certificate serves its TLS.
     */
    tlsAuthority: Schema.NullOr(
      Schema.Struct({ certificatePem: Schema.String, keyPem: Schema.String })
    ),
  }),
})

export type PlatformRecovery = typeof PlatformRecoverySchema.Type

export const decodePlatformRecovery = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PlatformRecoverySchema)
)

/**
 * This Relay's recovery section, or null when it doesn't host Kiln itself:
 * a Hearth run by hand keeps its keyring in the operator's environment, so
 * its backups stay format 1.
 */
export const collectPlatformRecovery = Effect.fn("Relay.platform.recovery")(
  function* (
    config: RelayConfig,
    state: Pick<RelayStateStore["Service"], "listClients">
  ) {
    const installation = yield* readPlatformState(config.dataDirectory)
    if (!installation) return null
    const [identity, tlsAuthority, clients] = yield* Effect.all(
      [
        readRelayIdentityMaterial(config),
        readRelayCertificateAuthority(config),
        state.listClients(),
      ],
      { concurrency: "unbounded" }
    )
    return {
      installation,
      relay: {
        clients: clients.map((client) => ({
          actions: client.actions,
          createdAt: client.createdAt,
          id: client.id,
          invitationId: client.invitationId,
          name: client.name,
          origins: client.origins,
          publicKey: client.publicKey,
          role: client.role,
          sourceCidrs: client.sourceCidrs,
        })),
        identity,
        tlsAuthority,
      },
    } satisfies PlatformRecovery
  }
)
