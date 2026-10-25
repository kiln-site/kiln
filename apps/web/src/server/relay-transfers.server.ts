/**
 * Copies files from one Relay to another without carrying them through
 * Hearth. Hearth asks the source to pack them, signs a grant that lets the
 * destination fetch that one artifact, asks the destination to pull it, and
 * discards the artifact once the destination is done. The Relays' own
 * records are the truth about a transfer, so any Hearth process can report
 * one; the process that started it drives it between steps.
 */
import { randomUUID, sign } from "node:crypto"

import {
  appIdFromFileRoot,
  databaseIdFromFileRoot,
  isRelayFileRoot,
  relayPeerTransfersV1Feature,
  RelayTransferPullSchema,
  RelayTransferSourceSchema,
  type AccessPermission,
  type RelayPeerEndpoint,
  type RelayPeerTransferGrant,
  type RelayTransferPull,
  type RelayTransferSource,
} from "@workspace/contracts"
import { Duration, Effect, Schedule, Schema } from "effect"

import { forkAppEffect } from "@/effect/runtime"
import { requireRelayPermissionEffect } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { PersistedRelay } from "@/lib/relay-registry"

// A grant outlives the slowest pull it's meant for, resumes included.
const GRANT_LIFETIME = Duration.days(2)
const SOURCE_POLL = Schedule.spaced("1 second")
const PULL_POLL = Schedule.spaced("2 seconds")

export interface RelayTransferSide {
  readonly relayId: string
  /** A file root: a game server's ID, `app:<appId>`, or a Relay's own. */
  readonly rootId: string
}

export interface RelayTransferRequest {
  readonly source: RelayTransferSide & {
    /** Paths under the root to copy; none copies the whole root. */
    readonly paths: ReadonlyArray<string>
  }
  readonly destination: RelayTransferSide & {
    /** The folder to copy into, missing or empty; empty for the root. */
    readonly path: string
  }
}

/** Something that keeps a transfer from starting, and what fixes it. */
export interface RelayTransferProblem {
  readonly code:
    | "database_root"
    | "hearth_access"
    | "relay_offline"
    | "relay_outdated"
  readonly relayId: string
  readonly message: string
  readonly remedy: string
}

/** Names a transfer for asking how it's going or cancelling it. */
export interface RelayTransferHandle {
  readonly transferId: string
  readonly source: RelayTransferSide
  readonly destination: RelayTransferSide
}

export interface RelayTransferStatus {
  readonly transferId: string
  readonly phase:
    | "packing"
    | "pulling"
    | "verifying"
    | "installing"
    | "completed"
    | "failed"
    | "cancelled"
  readonly receivedBytes: number
  /** The artifact's size, once the source has packed it. */
  readonly size: number | null
  readonly error: string | null
}

export class RelayTransferError extends Schema.TaggedError<RelayTransferError>()(
  "RelayTransferError",
  {
    message: Schema.String,
    problems: Schema.optional(Schema.Array(Schema.Unknown)),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

// Failures of the steps between Relays in this process, which no Relay
// records, kept for a day for anyone asking about the transfer.
const orchestrationFailures = new Map<
  string,
  { error: string; expiresAt: number }
>()

/**
 * What would keep the transfer from starting, checked after the person's
 * own access: whether both Relays are online, new enough, and let this
 * Hearth move files in and out of the roots.
 */
export const preflightRelayTransferEffect = Effect.fn(
  "RelayTransfers.preflight"
)(function* (user: AuthenticatedUser, request: RelayTransferRequest) {
  const { source, destination } = yield* authorizeTransferEffect(user, request)
  const problems: Array<RelayTransferProblem> = []
  for (const [relay, rootId, direction] of [
    [source, request.source.rootId, "download"],
    [destination, request.destination.rootId, "upload"],
  ] as const) {
    if (databaseIdFromFileRoot(rootId) !== null) {
      problems.push({
        code: "database_root",
        message: "Databases can't be copied as files",
        relayId: relay.id,
        remedy: "Export the database's dump and import it on the other Relay",
      })
      continue
    }
    const { relayConnectionFeatures } = yield* Effect.promise(
      () => import("@/lib/relay-connection")
    )
    if (!(yield* relayReachable(relay))) {
      problems.push({
        code: "relay_offline",
        message: `${relay.name} is offline`,
        relayId: relay.id,
        remedy: `Wait for ${relay.name} to reconnect, then try again`,
      })
      continue
    }
    if (!relayConnectionFeatures(relay.id).has(relayPeerTransfersV1Feature)) {
      problems.push({
        code: "relay_outdated",
        message: `${relay.name} can't copy files between Relays yet`,
        relayId: relay.id,
        remedy: `Update ${relay.name} to the latest Kiln release`,
      })
      continue
    }
    const action = clientTransferAction(rootId, direction)
    if (relay.role !== "full_access" && !relay.actions.includes(action)) {
      problems.push({
        code: "hearth_access",
        message: `Hearth isn't allowed to ${direction} files on ${relay.name}`,
        relayId: relay.id,
        remedy: `Grant Hearth's pairing on ${relay.name} the ${action} action`,
      })
    }
  }
  return problems
})

/**
 * Starts copying files from one Relay to another and returns at once, with
 * the handle to follow it by. The copy goes on in the background.
 */
export const startRelayTransferEffect = Effect.fn("RelayTransfers.start")(
  function* (user: AuthenticatedUser, request: RelayTransferRequest) {
    const problems = yield* preflightRelayTransferEffect(user, request)
    if (problems.length) {
      return yield* new RelayTransferError({
        message: problems.map((problem) => problem.message).join(". "),
        problems,
      })
    }
    const { source, destination } = yield* authorizeTransferEffect(
      user,
      request
    )
    const transferId = randomUUID().replaceAll("-", "")
    yield* Effect.annotateCurrentSpan({
      "kiln.transfer.id": transferId,
      "kiln.transfer.source_relay": source.id,
      "kiln.transfer.destination_relay": destination.id,
    })
    yield* rpc(source, "transfer.source.prepare", user, {
      paths: request.source.paths,
      rootId: request.source.rootId,
      transferId,
    })
    const handle: RelayTransferHandle = {
      destination: {
        relayId: destination.id,
        rootId: request.destination.rootId,
      },
      source: { relayId: source.id, rootId: request.source.rootId },
      transferId,
    }
    forkAppEffect(
      "RelayTransfers.drive",
      driveTransferEffect(user, source, destination, request, transferId).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            orchestrationFailures.set(transferId, {
              error: errorMessage(cause),
              expiresAt: Date.now() + 24 * 60 * 60_000,
            })
          })
        ),
        Effect.annotateLogs({ "kiln.transfer.id": transferId })
      )
    )
    return handle
  }
)

/** How a transfer is going, from the Relays' own records. */
export const relayTransferStatusEffect = Effect.fn("RelayTransfers.status")(
  function* (user: AuthenticatedUser, handle: RelayTransferHandle) {
    const { source, destination } = yield* authorizeTransferEffect(user, {
      destination: { ...handle.destination, path: "" },
      source: { ...handle.source, paths: [] },
    })
    const reference = (side: RelayTransferSide) => ({
      rootId: side.rootId,
      transferId: handle.transferId,
    })
    const [pull, packed] = yield* Effect.all(
      [
        rpc(
          destination,
          "transfer.pull.get",
          user,
          reference(handle.destination)
        ).pipe(Effect.flatMap(decodeOptional(RelayTransferPullSchema))),
        rpc(source, "transfer.source.get", user, reference(handle.source)).pipe(
          Effect.flatMap(decodeOptional(RelayTransferSourceSchema))
        ),
      ],
      { concurrency: 2 }
    )
    for (const [id, failure] of orchestrationFailures) {
      if (failure.expiresAt <= Date.now()) orchestrationFailures.delete(id)
    }
    return transferStatus(
      handle.transferId,
      pull,
      packed,
      orchestrationFailures.get(handle.transferId)?.error ?? null
    )
  }
)

/** Stops a transfer and deletes what either Relay holds for it. */
export const cancelRelayTransferEffect = Effect.fn("RelayTransfers.cancel")(
  function* (user: AuthenticatedUser, handle: RelayTransferHandle) {
    const { source, destination } = yield* authorizeTransferEffect(user, {
      destination: { ...handle.destination, path: "" },
      source: { ...handle.source, paths: [] },
    })
    yield* rpc(destination, "transfer.pull.cancel", user, {
      rootId: handle.destination.rootId,
      transferId: handle.transferId,
    })
    yield* rpc(source, "transfer.source.discard", user, {
      rootId: handle.source.rootId,
      transferId: handle.transferId,
    })
  }
)

// Waits for the source to pack, has the destination pull, waits for it to
// finish, then discards the source's artifact.
const driveTransferEffect = Effect.fn("RelayTransfers.drive")(function* (
  user: AuthenticatedUser,
  source: PersistedRelay,
  destination: PersistedRelay,
  request: RelayTransferRequest,
  transferId: string
) {
  const sourceReference = { rootId: request.source.rootId, transferId }
  const packed = yield* rpc(
    source,
    "transfer.source.get",
    user,
    sourceReference
  ).pipe(
    Effect.flatMap(decodeOptional(RelayTransferSourceSchema)),
    Effect.repeat({
      schedule: SOURCE_POLL,
      until: (record) => record === null || record.state !== "packing",
    })
  )
  if (
    !packed ||
    packed.state !== "ready" ||
    !packed.sha256 ||
    packed.size === null
  ) {
    return yield* new RelayTransferError({
      message: packed?.error ?? "The source Relay lost the transfer",
    })
  }
  const grant = yield* signGrant(source, destination, {
    sha256: packed.sha256,
    size: packed.size,
    transferId,
  })
  yield* rpc(destination, "transfer.pull.start", user, {
    endpoints: yield* sourceEndpoints(source),
    grant,
    target: {
      path: request.destination.path,
      rootId: request.destination.rootId,
    },
    transferId,
  })
  yield* rpc(destination, "transfer.pull.get", user, {
    rootId: request.destination.rootId,
    transferId,
  }).pipe(
    Effect.flatMap(decodeOptional(RelayTransferPullSchema)),
    Effect.repeat({
      schedule: PULL_POLL,
      until: (pull) =>
        pull === null ||
        pull.state === "completed" ||
        pull.state === "failed" ||
        pull.state === "cancelled",
    })
  )
  yield* rpc(source, "transfer.source.discard", user, sourceReference)
})

// The person may read files under the source root and write under the
// destination's, on Relays this Hearth has.
const authorizeTransferEffect = Effect.fn("RelayTransfers.authorize")(
  function* (user: AuthenticatedUser, request: RelayTransferRequest) {
    const { activeRelay } = yield* Effect.promise(
      () => import("@/lib/relay-registry")
    )
    const [source, destination] = yield* Effect.all(
      [
        Effect.tryPromise(() => activeRelay(request.source.relayId)),
        Effect.tryPromise(() => activeRelay(request.destination.relayId)),
      ],
      { concurrency: 2 }
    )
    yield* Effect.all(
      [
        requireRootPermission(user, source.id, request.source.rootId, "read"),
        requireRootPermission(
          user,
          destination.id,
          request.destination.rootId,
          "write"
        ),
      ],
      { concurrency: 2, discard: true }
    )
    return { destination, source }
  }
)

function requireRootPermission(
  user: AuthenticatedUser,
  relayId: string,
  rootId: string,
  access: "read" | "write"
) {
  if (isRelayFileRoot(rootId)) {
    if (rootId !== relayId) {
      return Effect.fail(new RelayTransferError({ message: "Relay not found" }))
    }
    return requireRelayPermissionEffect({
      permission: `relay.files.${access}` satisfies AccessPermission,
      relayId,
      user,
    })
  }
  const appId = appIdFromFileRoot(rootId)
  if (appId) {
    return requireRelayPermissionEffect({
      appId,
      permission: `app.files.${access}` satisfies AccessPermission,
      relayId,
      user,
    })
  }
  const databaseId = databaseIdFromFileRoot(rootId)
  if (databaseId) {
    return requireRelayPermissionEffect({
      databaseId,
      permission:
        access === "read" ? "database.dump.export" : "database.dump.import",
      relayId,
      user,
    })
  }
  return requireRelayPermissionEffect({
    instanceId: rootId,
    permission: `instance.files.${access}` satisfies AccessPermission,
    relayId,
    user,
  })
}

// Whether this process can reach the Relay, connecting first if it hasn't:
// each Hearth process opens its Relay connections when it first needs them.
function relayReachable(relay: PersistedRelay) {
  return Effect.tryPromise(async () => {
    const { relayConnectionState, relayRpc } =
      await import("@/lib/relay-connection")
    if (relayConnectionState(relay.id).status === "authenticated") return
    await relayRpc(relay, "operation.get", { operationId: randomUUID() }, 5_000)
  }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )
}

// The Relay client action Hearth needs on a Relay to move files out of or
// into a root, as the Relay checks it.
function clientTransferAction(
  rootId: string,
  direction: "download" | "upload"
): string {
  if (isRelayFileRoot(rootId)) return `relay.files.${direction}`
  if (appIdFromFileRoot(rootId) !== null) return `app.files.${direction}`
  return `instance.files.${direction}`
}

// A grant for the destination to fetch one artifact from the source, signed
// with the key Hearth is paired to the source under.
const signGrant = Effect.fn("RelayTransfers.signGrant")(function* (
  source: PersistedRelay,
  destination: PersistedRelay,
  artifact: { sha256: string; size: number; transferId: string }
) {
  const { loadRelayCredentials } = yield* Effect.promise(
    () => import("@/lib/relay-registry")
  )
  const credentials = yield* Effect.tryPromise(() =>
    loadRelayCredentials(source.id)
  )
  const now = Date.now()
  const grant: RelayPeerTransferGrant = {
    audience: source.id,
    expiresAt: now + Duration.toMillis(GRANT_LIFETIME),
    issuedAt: now,
    issuer: credentials.clientId,
    peer: destination.id,
    sha256: artifact.sha256,
    size: artifact.size,
    transferId: artifact.transferId,
    version: 1,
  }
  const encoded = Buffer.from(JSON.stringify(grant)).toString("base64url")
  const signature = sign(
    null,
    Buffer.from(encoded),
    credentials.clientPrivateKeyPem
  ).toString("base64url")
  return `${encoded}.${signature}`
})

// Where the destination may reach the source: the listener Hearth itself
// reaches, through the CA Hearth pinned for it, then the address the Relay
// advertised, then its public origin.
const sourceEndpoints = Effect.fn("RelayTransfers.sourceEndpoints")(function* (
  source: PersistedRelay
) {
  const [{ loadRelayCredentials }, { relayControlEndpoint }] =
    yield* Effect.all(
      [
        Effect.promise(() => import("@/lib/relay-registry")),
        Effect.promise(() => import("@/lib/relay-control-endpoint")),
      ],
      { concurrency: 2 }
    )
  const credentials = yield* Effect.tryPromise(() =>
    loadRelayCredentials(source.id)
  )
  const endpoint = (relay: {
    hostname: string
    port: number
    useTls: boolean
  }): RelayPeerEndpoint => ({
    caCertificatePem: relay.useTls ? credentials.caCertificatePem : null,
    url: `${relay.useTls ? "https" : "http"}://${
      relay.hostname.includes(":") ? `[${relay.hostname}]` : relay.hostname
    }:${relay.port}`,
  })
  const candidates = [
    endpoint(relayControlEndpoint(source)),
    endpoint(source),
    ...(source.browserOrigin
      ? [{ caCertificatePem: null, url: source.browserOrigin }]
      : []),
  ]
  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (other) => new URL(other.url).origin === new URL(candidate.url).origin
      ) === index
  )
})

function rpc(
  relay: PersistedRelay,
  operation:
    | "transfer.pull.cancel"
    | "transfer.pull.get"
    | "transfer.pull.start"
    | "transfer.source.discard"
    | "transfer.source.get"
    | "transfer.source.prepare",
  user: AuthenticatedUser,
  payload: unknown
): Effect.Effect<unknown, RelayTransferError> {
  return Effect.tryPromise({
    try: async () => {
      const { relayRpc } = await import("@/lib/relay-connection")
      return relayRpc(relay, operation, payload, undefined, user.id)
    },
    catch: (cause) =>
      new RelayTransferError({
        message: `${relay.name}: ${errorMessage(cause)}`,
        cause,
      }),
  })
}

function decodeOptional<A, I>(schema: Schema.Codec<A, I>) {
  const decode = Schema.decodeUnknownEffect(Schema.NullOr(schema))
  return (value: unknown) =>
    decode(value ?? null).pipe(
      Effect.mapError(
        (cause) =>
          new RelayTransferError({
            message: "A Relay answered with an invalid transfer record",
            cause,
          })
      )
    )
}

function transferStatus(
  transferId: string,
  pull: RelayTransferPull | null,
  packed: RelayTransferSource | null,
  orchestrationError: string | null
): RelayTransferStatus {
  if (pull) {
    return {
      error: pull.error,
      phase: pull.state,
      receivedBytes: pull.receivedBytes,
      size: pull.size,
      transferId,
    }
  }
  if (orchestrationError || !packed || packed.state === "failed") {
    return {
      error:
        orchestrationError ??
        packed?.error ??
        "Neither Relay has this transfer",
      phase: "failed",
      receivedBytes: 0,
      size: packed?.size ?? null,
      transferId,
    }
  }
  return {
    error: null,
    phase: packed.state === "packing" ? "packing" : "pulling",
    receivedBytes: 0,
    size: packed.size,
    transferId,
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
