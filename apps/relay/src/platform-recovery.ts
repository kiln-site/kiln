/**
 * What a platform backup carries besides Hearth's database, so the backup
 * and its recovery code alone restore Kiln on a new machine: the
 * installation's record with its secrets, and its Relay's identity
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
import { type HostedKiln, readHostedKiln } from "./hosted-kiln.js"
import { defaultHearthImage, newPlatformState } from "./platform.js"
import { platformBackupKey } from "./platform-backup-key.js"
import {
  PlatformError,
  type PlatformState,
  PlatformStateSchema,
  readPlatformState,
} from "./platform-state.js"

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
 * This Relay's recovery section: of the Kiln it installed, or else of the
 * one something else runs beside it, once its Hearth has proved itself.
 */
export const collectPlatformRecovery = Effect.fn("Relay.platform.recovery")(
  function* (config: RelayConfig, state: RelayStateStore["Service"]) {
    const [identity, tlsAuthority, clients] = yield* Effect.all(
      [
        readRelayIdentityMaterial(config),
        readRelayCertificateAuthority(config),
        state.listClients(),
      ],
      { concurrency: "unbounded" }
    )
    const { installationId } = config
    const [installed, key, hosted] = installationId
      ? yield* Effect.all([
          readPlatformState(config.dataDirectory),
          platformBackupKey(config, state),
          readHostedKiln(state, installationId),
        ])
      : [null, null, null]
    const installation =
      installed?.installationId === installationId
        ? installed
        : installationId && key && hosted
          ? hostedPlatformState(
              config,
              installationId,
              hosted,
              key,
              // Its Hearth manages it where the Relay runs it.
              clients.flatMap(({ id, invitationId }) =>
                id === hosted.clientId ? [invitationId] : []
              )
            )
          : null
    if (!installation) {
      return yield* new PlatformError({
        reason:
          "Kiln can't be backed up yet. The Relay learns what a backup needs once Hearth connects to it from the same machine.",
      })
    }
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

/**
 * The record a Relay would have had it installed this Kiln, for a new machine
 * to run it from: its ID, auth secrets, address and database, and passwords
 * of its own for the database it's restored into.
 */
function hostedPlatformState(
  config: Pick<RelayConfig, "advertisedHost" | "gitRepository" | "port">,
  installationId: string,
  kiln: HostedKiln,
  backupKey: string,
  ownerInvitationIds: ReadonlyArray<string>
): PlatformState {
  const state = newPlatformState(
    {
      advertisedHost: config.advertisedHost,
      platformBackupKey: backupKey,
      port: config.port,
      resourceNamespace: null,
    },
    {
      authSecrets: kiln.authSecrets,
      bindAddress: null,
      cacheImage: undefined,
      databaseImage: kiln.databaseImage,
      environment: {},
      hearthImage: null,
      installationId,
      port: null,
      url: kiln.url,
    },
    defaultHearthImage(null, config.gitRepository)
  )
  return {
    ...state,
    database: {
      ...state.database,
      name: kiln.databaseName,
      ...(kiln.tablePrefix && { tablePrefix: kiln.tablePrefix }),
    },
    ownerInvitationIds: [...ownerInvitationIds],
    phase: "ready",
  }
}
