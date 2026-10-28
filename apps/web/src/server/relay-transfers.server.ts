/**
 * Copies files from one Relay to another without carrying them through
 * Hearth. Hearth asks the source to pack them, signs a grant that lets the
 * destination fetch that one artifact, asks the destination to pull it, and
 * discards the artifact once the destination is done. The Relays' own
 * records are the truth about a transfer, so any Hearth process can report
 * one. A durable operation drives it between steps, so it carries on after
 * a restart, in whichever Hearth takes it over.
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
import { shared, type LaneLock } from "@workspace/operations"
import { Duration, Effect, Schedule, Schema } from "effect"
import { Activity } from "effect/workflow"

import { requireRelayPermissionEffect } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { PersistedRelay } from "@/lib/relay-registry"
import { currentActingUser } from "@/operations/acting-user"
import {
  CurrentOperation,
  durableOperation,
  startDurableOperation,
} from "@/operations/durable"
import { findOperation, reportProgress } from "@/operations/lanes"
import { relayIsAway } from "@/operations/relay-command"

// A grant outlives the slowest pull it's meant for, resumes included.
const GRANT_LIFETIME = Duration.days(2)
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

/**
 * What would keep the transfer from starting, checked after the person's
 * own access: whether both Relays are online, new enough, and let this
 * Hearth move files in and out of the roots.
 */
export const preflightRelayTransferEffect = Effect.fn(
  "RelayTransfers.preflight"
)(function* (user: AuthenticatedUser, request: RelayTransferRequest) {
  const { source, destination } = yield* authorizeTransferEffect(user, request)
  return yield* relayTransferProblemsEffect({
    destination,
    destinationRootId: request.destination.rootId,
    source,
    sourceRootId: request.source.rootId,
  })
})

/**
 * What would keep files moving from a root on one Relay to a root on
 * another, whatever the person may do: an offline or outdated Relay, a root
 * that can't be copied as files, or a pairing that doesn't let Hearth move
 * files in or out. The roots needn't exist yet; only their kind matters.
 */
export const relayTransferProblemsEffect = Effect.fn("RelayTransfers.problems")(
  function* (input: {
    readonly destination: PersistedRelay
    readonly destinationRootId: string
    readonly source: PersistedRelay
    readonly sourceRootId: string
  }) {
    const problems: Array<RelayTransferProblem> = []
    const sides = [
      [input.source, input.sourceRootId, "download"],
      [input.destination, input.destinationRootId, "upload"],
    ] as const
    const { relayConnectionFeatures } = yield* Effect.promise(
      () => import("@/lib/relay-connection")
    )
    for (const [relay, rootId, direction] of sides) {
      if (databaseIdFromFileRoot(rootId) !== null) {
        problems.push({
          code: "database_root",
          message: "Databases can't be copied as files",
          relayId: relay.id,
          remedy: "Export the database's dump and import it on the other Relay",
        })
        continue
      }
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
    // The same Relay on both sides is checked once.
    return problems.filter(
      (problem, index) =>
        problems.findIndex(
          (other) =>
            other.code === problem.code && other.relayId === problem.relayId
        ) === index
    )
  }
)

/**
 * Starts copying files from one Relay to another and returns at once, with
 * the handle to follow it by. The copy goes on in the background.
 */
export const startRelayTransferEffect = Effect.fn("RelayTransfers.start")(
  function* (user: AuthenticatedUser, request: RelayTransferRequest) {
    const transferId = randomUUID().replaceAll("-", "")
    // Begun here too, so the person hears at once what keeps it from
    // starting; the operation begins it again under the same ID.
    const handle = yield* beginRelayTransferEffect(user, request, transferId)
    yield* startDurableOperation(
      relayTransfer,
      { actor: user, request, transferId },
      { actorId: user.id, idempotencyKey: transferId }
    )
    return handle
  }
)

const RelayTransferStatusSchema = Schema.Struct({
  error: Schema.NullOr(Schema.String),
  phase: Schema.Literals([
    "packing",
    "pulling",
    "verifying",
    "installing",
    "completed",
    "failed",
    "cancelled",
  ]),
  receivedBytes: Schema.Number,
  size: Schema.NullOr(Schema.Number),
  transferId: Schema.String,
})

/**
 * A transfer as steps of a durable operation, named `name`: begun under
 * `transferId`, which the caller keeps, then followed through the Relays'
 * records until it ends, however it ends. Both steps are safe to repeat, so
 * a Hearth that restarts partway carries on where the Relays are.
 */
export const followRelayTransfer = (
  name: string,
  actor: AuthenticatedUser,
  request: RelayTransferRequest,
  transferId: string
) =>
  Effect.gen(function* () {
    yield* Activity.make({
      name: `${name}/begin`,
      error: RelayTransferError,
      execute: beginRelayTransferEffect(actor, request, transferId).pipe(
        whileRelaysAreAway
      ),
    })
    const operation = yield* CurrentOperation
    return yield* Activity.make({
      name: `${name}/follow`,
      success: RelayTransferStatusSchema,
      error: RelayTransferError,
      execute: advanceRelayTransferEffect(actor, request, transferId).pipe(
        whileRelaysAreAway,
        Effect.tap((status) =>
          operation
            ? reportProgress(operation.id, {
                message: progressMessage[status.phase],
                ...(status.size === null
                  ? {}
                  : { done: status.receivedBytes, total: status.size }),
              }).pipe(Effect.ignore)
            : Effect.void
        ),
        Effect.repeat({
          schedule: PULL_POLL,
          until: (status) => finishedPhases.has(status.phase),
        })
      ),
    })
  })

const progressMessage: Record<RelayTransferStatus["phase"], string> = {
  cancelled: "Cancelled",
  completed: "Copied",
  failed: "Failed",
  installing: "Putting the files in place",
  packing: "Packing the files",
  pulling: "Copying the files",
  verifying: "Checking the copy",
}

// A Relay that's unreachable, paused, or restarting is asked again; its
// answers, and anything else that fails, such as the person losing access,
// are final.
const whileRelaysAreAway = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof RelayTransferError
        ? error
        : new RelayTransferError({ message: errorMessage(error), cause: error })
    ),
    Effect.retry({
      schedule: Schedule.min([
        Schedule.exponential("1 second"),
        Schedule.spaced("30 seconds"),
      ]),
      while: (error) => relayIsAway(error.cause),
    })
  )

/**
 * Copying files from one Relay to another for someone, as its own
 * operation. It reads the source and writes the destination, so work that
 * replaces either, such as deleting it, waits for it to end.
 */
export const relayTransfer = durableOperation({
  error: RelayTransferError,
  input: Schema.Struct({
    // Who asked, as they were then; their account is checked again.
    actor: Schema.Unknown,
    request: Schema.Struct({
      destination: Schema.Struct({
        path: Schema.String,
        relayId: Schema.String,
        rootId: Schema.String,
      }),
      source: Schema.Struct({
        paths: Schema.Array(Schema.String),
        relayId: Schema.String,
        rootId: Schema.String,
      }),
    }),
    transferId: Schema.String,
  }),
  kind: "relay.transfer",
  locks: ({ request }) => [
    rootLock(request.source),
    rootLock(request.destination),
  ],
  run: ({ actor, request, transferId }) =>
    Effect.gen(function* () {
      const user = yield* currentActingUser(actor as AuthenticatedUser).pipe(
        Effect.mapError(
          (cause) =>
            new RelayTransferError({ message: errorMessage(cause), cause })
        )
      )
      const status = yield* followRelayTransfer(
        "transfer",
        user,
        request,
        transferId
      )
      // One cancelled was stopped on purpose, so it ends as done.
      if (status.phase === "failed") {
        return yield* new RelayTransferError({
          message: status.error ?? "The copy failed",
        })
      }
      return status
    }),
  success: RelayTransferStatusSchema,
  version: 1,
})

// What a transfer reads or writes, by its file root, as Hearth's lanes name
// it.
function rootLock(side: RelayTransferSide): LaneLock {
  if (isRelayFileRoot(side.rootId)) return shared(`relay:${side.relayId}`)
  const appId = appIdFromFileRoot(side.rootId)
  return shared(
    appId
      ? `app:${side.relayId}/${appId}`
      : `instance:${side.relayId}/${side.rootId}`
  )
}

/**
 * Has the source start packing a transfer under `transferId`, once the
 * preflight passes. Asking again with the same ID changes nothing, so a
 * caller that keeps the ID, such as a server migration, can resume.
 */
export const beginRelayTransferEffect = Effect.fn("RelayTransfers.begin")(
  function* (
    user: AuthenticatedUser,
    request: RelayTransferRequest,
    transferId: string
  ) {
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
    return {
      destination: {
        relayId: destination.id,
        rootId: request.destination.rootId,
      },
      source: { relayId: source.id, rootId: request.source.rootId },
      transferId,
    } satisfies RelayTransferHandle
  }
)

/**
 * Takes a transfer its next step, from the Relays' records, and reports
 * where it is: once the source has packed it, signs the grant and has the
 * destination pull it; once the pull ends, discards the source's artifact.
 * Each step is safe to repeat, so whoever drives a transfer can stop and
 * another caller can carry on.
 */
export const advanceRelayTransferEffect = Effect.fn("RelayTransfers.advance")(
  function* (
    user: AuthenticatedUser,
    request: RelayTransferRequest,
    transferId: string
  ) {
    const { source, destination } = yield* authorizeTransferEffect(
      user,
      request
    )
    const sourceReference = { rootId: request.source.rootId, transferId }
    const pullReference = { rootId: request.destination.rootId, transferId }
    const pull = yield* rpc(
      destination,
      "transfer.pull.get",
      user,
      pullReference
    ).pipe(Effect.flatMap(decodeOptional(RelayTransferPullSchema)))
    if (pull) {
      if (finishedPhases.has(pull.state)) {
        yield* rpc(source, "transfer.source.discard", user, sourceReference)
      }
      return transferStatus(transferId, pull, null, null)
    }
    const packed = yield* rpc(
      source,
      "transfer.source.get",
      user,
      sourceReference
    ).pipe(Effect.flatMap(decodeOptional(RelayTransferSourceSchema)))
    if (
      !packed ||
      packed.state !== "ready" ||
      !packed.sha256 ||
      packed.size === null
    ) {
      return transferStatus(transferId, null, packed, null)
    }
    const grant = yield* signGrant(source, destination, {
      sha256: packed.sha256,
      size: packed.size,
      transferId,
    })
    const started = yield* rpc(destination, "transfer.pull.start", user, {
      endpoints: yield* sourceEndpoints(source),
      grant,
      target: {
        path: request.destination.path,
        rootId: request.destination.rootId,
      },
      transferId,
    }).pipe(Effect.flatMap(decodeOptional(RelayTransferPullSchema)))
    return transferStatus(transferId, started, packed, null)
  }
)

const finishedPhases: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
])

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
    // A step between the Relays that failed is the operation's error.
    const operation = yield* findOperation(
      relayTransfer.kind,
      handle.transferId
    ).pipe(Effect.orElseSucceed(() => null))
    return transferStatus(
      handle.transferId,
      pull,
      packed,
      operation?.state === "failed" && !pull ? operation.error : null
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
// advertised, then its public origin, and last through Hearth, which every
// Relay reaches, for a source the destination can't, such as one behind a
// home router.
export const sourceEndpoints = Effect.fn("RelayTransfers.sourceEndpoints")(
  function* (source: PersistedRelay) {
    const [{ loadRelayCredentials }, { hearthDialUrl, relayControlEndpoint }] =
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
      ...throughHearth(hearthDialUrl(), source.id),
    ]
    // The same address once, as a destination would reach it: Hearth's
    // pass-through can share an origin with the source, as behind one router.
    const reached = (candidate: RelayPeerEndpoint) =>
      `${new URL(candidate.url).href}\n${candidate.caCertificatePem ?? ""}`
    return candidates.filter(
      (candidate, index) =>
        candidates.findIndex(
          (other) => reached(other) === reached(candidate)
        ) === index
    )
  }
)

function throughHearth(
  hearth: string | null,
  relayId: string
): Array<RelayPeerEndpoint> {
  return hearth
    ? [
        {
          caCertificatePem: null,
          url: new URL(
            `/api/relays/${encodeURIComponent(relayId)}/peer`,
            hearth
          ).href,
        },
      ]
    : []
}

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
