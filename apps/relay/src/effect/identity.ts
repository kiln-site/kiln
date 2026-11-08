import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto"
import { chmod, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_RELAY_NAME,
  InstanceId,
  migratedInstanceId,
  newInstanceId,
  truncateInitialRelayName,
} from "@workspace/contracts"
import { Effect, Schema } from "effect"

import { RelayIdentityError } from "./errors.js"
import { writeFileAtomic as atomicWriteFile } from "./atomic-file.js"
import type { RelayConfig } from "../config.js"

export interface RelayIdentity {
  // Its instance ID, which Hearth and everything else know it by.
  readonly id: string
  // Its public key's fingerprint, which only authenticates it: pairing and
  // signatures.
  readonly fingerprint: string
  readonly name: string
  readonly privateKeyPem: string
  readonly publicKeyPem: string
}

const StoredRelayIdentitySchema = Schema.Union([
  Schema.Struct({
    id: InstanceId,
    name: Schema.String,
    publicKeyPem: Schema.String,
    version: Schema.Literal(2),
  }),
  // From before 12-character instance IDs, when its fingerprint was its ID.
  Schema.Struct({
    name: Schema.String,
    publicKeyPem: Schema.String,
    version: Schema.Literal(1),
  }),
])

export const loadOrCreateRelayIdentity = Effect.fn(
  "RelayIdentity.loadOrCreate"
)(function* (config: RelayConfig) {
  const identityDirectory = join(config.dataDirectory, "network", "identity")
  const identityPath = join(identityDirectory, "identity.json")
  const privateKeyPath = join(identityDirectory, "identity.key")

  yield* tryPromise("create_directory", () =>
    mkdir(identityDirectory, { recursive: true, mode: 0o700 })
  )

  const loaded = yield* loadExisting(identityPath, privateKeyPath).pipe(
    Effect.catchIf(
      (error) => error.operation === "identity_missing",
      () => createIdentity(config.nodeName, identityPath, privateKeyPath)
    )
  )
  const relayFingerprint = fingerprint(loaded.publicKeyPem)
  if (loaded.id !== null) {
    return { ...loaded, id: loaded.id, fingerprint: relayFingerprint }
  }
  // A Relay from before 12-character instance IDs takes the one its
  // fingerprint maps to, as Hearth computes it too, and keeps it.
  const id = yield* Effect.promise(() =>
    migratedInstanceId({ kind: "relay", fingerprint: relayFingerprint })
  )
  yield* writeIdentity(identityPath, {
    id,
    name: loaded.name,
    publicKeyPem: loaded.publicKeyPem,
  })
  return {
    ...loaded,
    id,
    fingerprint: relayFingerprint,
  } satisfies RelayIdentity
})

export const renameRelayIdentity = Effect.fn("RelayIdentity.rename")(function* (
  config: RelayConfig,
  identity: RelayIdentity,
  value: string
) {
  const name = value.trim()
  if (!name || name.length > 120) {
    return yield* Effect.fail(
      RelayIdentityError.make({
        operation: "rename_identity",
        cause: new Error("Relay name must contain 1 to 120 characters"),
      })
    )
  }
  const identityPath = join(
    config.dataDirectory,
    "network",
    "identity",
    "identity.json"
  )
  yield* writeIdentity(identityPath, {
    id: identity.id,
    name,
    publicKeyPem: identity.publicKeyPem,
  })
  return { ...identity, name } satisfies RelayIdentity
})

const loadExisting = Effect.fn("RelayIdentity.loadExisting")(function* (
  identityPath: string,
  privateKeyPath: string
) {
  const files = yield* Effect.tryPromise({
    try: () =>
      Promise.all([
        readFile(identityPath, "utf8"),
        readFile(privateKeyPath, "utf8"),
      ]),
    catch: (cause) => cause,
  }).pipe(
    Effect.mapError((cause) =>
      RelayIdentityError.make({
        operation: isMissingFile(cause) ? "identity_missing" : "read_identity",
        cause,
      })
    )
  )

  const stored = yield* Effect.try({
    try: () => JSON.parse(files[0]) as unknown,
    catch: (cause) =>
      RelayIdentityError.make({ operation: "parse_identity", cause }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(StoredRelayIdentitySchema)),
    Effect.mapError((cause) =>
      cause instanceof RelayIdentityError
        ? cause
        : RelayIdentityError.make({ operation: "decode_identity", cause })
    )
  )

  yield* Effect.try({
    try: () => {
      const privateKey = createPrivateKey(files[1])
      const derivedPublicKey = createPublicKey(privateKey).export({
        format: "pem",
        type: "spki",
      })
      if (derivedPublicKey !== stored.publicKeyPem) {
        throw new Error("Relay identity public and private keys do not match")
      }
    },
    catch: (cause) =>
      RelayIdentityError.make({ operation: "validate_identity", cause }),
  })
  yield* tryPromise("protect_private_key", () => chmod(privateKeyPath, 0o600))

  return {
    id: stored.version === 2 ? stored.id : null,
    name: stored.name,
    privateKeyPem: files[1],
    publicKeyPem: stored.publicKeyPem,
  }
})

const createIdentity = Effect.fn("RelayIdentity.create")(function* (
  configuredName: string,
  identityPath: string,
  privateKeyPath: string
) {
  const keys = yield* Effect.try({
    try: () =>
      generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      }),
    catch: (cause) =>
      RelayIdentityError.make({ operation: "generate_identity", cause }),
  })
  const name = normalizeName(configuredName)
  const id = newInstanceId()
  yield* writeFileAtomic(privateKeyPath, keys.privateKey, 0o600)
  yield* writeIdentity(identityPath, {
    id,
    name,
    publicKeyPem: keys.publicKey,
  })
  return {
    id: id as string | null,
    name,
    privateKeyPem: keys.privateKey,
    publicKeyPem: keys.publicKey,
  }
})

function writeIdentity(
  identityPath: string,
  identity: { id: string; name: string; publicKeyPem: string }
) {
  return writeFileAtomic(
    identityPath,
    `${JSON.stringify({ ...identity, version: 2 })}\n`,
    0o600
  )
}

export function fingerprint(publicKeyPem: string): string {
  return createHash("sha256")
    .update(
      createPublicKey(publicKeyPem).export({ format: "der", type: "spki" })
    )
    .digest("base64url")
}

function normalizeName(configuredName: string): string {
  const name = truncateInitialRelayName(configuredName)
  return name || DEFAULT_RELAY_NAME
}

function writeFileAtomic(path: string, value: string, mode: number) {
  return atomicWriteFile(path, value, mode).pipe(
    Effect.mapError((cause) =>
      RelayIdentityError.make({ operation: "write_identity", cause })
    ),
    Effect.withSpan("relay.identity.write_identity")
  )
}

function tryPromise<T>(operation: string, run: () => Promise<T>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => RelayIdentityError.make({ operation, cause }),
  }).pipe(Effect.withSpan(`relay.identity.${operation}`))
}

function isMissingFile(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause as NodeJS.ErrnoException).code === "ENOENT"
  )
}
