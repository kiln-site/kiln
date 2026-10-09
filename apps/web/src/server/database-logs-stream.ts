import { randomBytes } from "node:crypto"

import {
  relayDatabaseLogsHeartbeatSchema,
  relayDatabaseLogsV1Feature,
  type HearthDatabaseLogsOutput,
} from "@workspace/contracts"
import { z } from "zod"

import { RelayUnavailableError } from "@/effect/errors"
import { ensuringPromise, forkPromise } from "@/effect/promise"
import { requireRelayPermission } from "@/lib/access-control"
import { isEligibleAccount } from "@/lib/account-policy"
import {
  getAuthenticatedRealtimeIdentityFromHeaders,
  type AuthenticatedUser,
} from "@/lib/auth-session"
import type {
  DatabaseLogsStreamError,
  DatabaseLogsStreamRecord,
} from "@/lib/database-logs-stream"
import { subscribeRealtimeChanges } from "@/lib/realtime-source.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { registerDatabaseLogsAttachment } from "@/server/database-logs-hub"
import { databaseRpc } from "@/server/managed-database-access"

// Renewals keep this page's follower on the Relay, which drops followers it
// hasn't heard from in a minute.
const HEARTBEAT_INTERVAL_MS = 20_000
const PING_INTERVAL_MS = 15_000
// Lines a page hasn't read yet. A page that falls this far behind is
// detached; it follows again from fresh history.
const MAX_QUEUED_LINES = 10_000

const encoder = new TextEncoder()

// Follows one database's container output for a page and streams it as
// NDJSON records until the page leaves, the container stops, or the Relay is
// lost.
export function openDatabaseLogsStream(input: {
  // The person's sign-in: its id, and the request headers that carry it, so
  // access can be checked again while the stream stays open.
  authSessionId: string
  databaseId: string
  headers: Headers
  relay: PersistedRelay
  signal: AbortSignal
  user: AuthenticatedUser
}): ReadableStream<Uint8Array> {
  const { databaseId, relay, user } = input
  const attachmentId = randomBytes(24).toString("base64url")
  const queued: Array<DatabaseLogsStreamRecord> = []
  let queuedLines = 0
  // Pushes can reach Hearth before the attach reply; they wait behind it.
  const early: Array<HearthDatabaseLogsOutput> = []
  let attached = false
  let closed = false
  let wake: (() => void) | null = null
  const timers: Array<ReturnType<typeof setInterval>> = []

  const send = (record: DatabaseLogsStreamRecord) => {
    if (closed) return
    if (record.type === "lines") {
      queuedLines += record.lines.length
      if (queuedLines > MAX_QUEUED_LINES) {
        queued.length = 0
        queuedLines = 0
        leave({
          code: "detached",
          message: "This page fell behind the database's output",
          type: "error",
        })
        return
      }
    }
    queued.push(record)
    wake?.()
  }
  const finish = (record?: DatabaseLogsStreamRecord) => {
    if (record) send(record)
    if (closed) return
    closed = true
    unregister()
    unsubscribe()
    for (const timer of timers) clearInterval(timer)
    input.signal.removeEventListener("abort", onAbort)
    wake?.()
  }
  const fail = (cause: unknown) =>
    finish({
      code: streamErrorCode(cause),
      message:
        cause instanceof Error
          ? cause.message
          : "Following the database's output failed",
      type: "error",
    })
  const deliver = (output: HearthDatabaseLogsOutput) => {
    if (!attached) {
      early.push(output)
      return
    }
    if (output.lines.length > 0) send({ lines: output.lines, type: "lines" })
    if (output.ended) finish({ ended: output.ended, type: "ended" })
  }
  const unregister = registerDatabaseLogsAttachment(
    attachmentId,
    relay.id,
    deliver
  )
  // A page that leaves stops its follower now rather than at expiry.
  const leave = (record?: DatabaseLogsStreamRecord) => {
    const wasOpen = !closed
    finish(record)
    if (wasOpen) {
      forkPromise(() =>
        databaseRpc(
          relay,
          "database.logs.detach",
          { attachmentId },
          10_000,
          user.id
        )
      )
    }
  }
  const onAbort = () => leave()
  input.signal.addEventListener("abort", onAbort, { once: true })

  // Access is checked again on every renewal and whenever the person's access
  // or sign-in changes. A page that lost it is detached; reattaching runs the
  // route's own checks, which tell the page why.
  let checking = false
  const recheck = () => {
    if (closed || checking) return
    checking = true
    const lost = () =>
      leave({
        code: "detached",
        message: "Checking access to these logs again",
        type: "error",
      })
    forkPromise(
      () =>
        ensuringPromise(
          async () => {
            if (!(await stillAuthorized(input))) lost()
          },
          () => {
            checking = false
          }
        ),
      lost
    )
  }
  const unsubscribe = subscribeRealtimeChanges((event) => {
    if (
      (event.type === "access.changed" && event.userIds.includes(user.id)) ||
      (event.type === "session.revoked" &&
        event.sessionIds.includes(input.authSessionId))
    ) {
      recheck()
    }
  })

  forkPromise(async () => {
    const { relayConnectionFeatures, relayConnectionState } =
      await import("@/lib/relay-connection")
    if (
      relayConnectionState(relay.id).status === "authenticated" &&
      !relayConnectionFeatures(relay.id).has(relayDatabaseLogsV1Feature)
    ) {
      finish({
        code: "unsupported",
        message: "Update this Relay to view database logs",
        type: "error",
      })
      return
    }
    await databaseRpc(
      relay,
      "database.logs.attach",
      { attachmentId, databaseId },
      30_000,
      user.id
    )
    if (closed) return
    send({ type: "attached" })
    attached = true
    timers.push(
      setInterval(() => send({ type: "ping" }), PING_INTERVAL_MS),
      setInterval(() => {
        recheck()
        forkPromise(async () => {
          const renewed = z.object({ unknown: z.array(z.string()) }).parse(
            await databaseRpc(
              relay,
              "database.logs.heartbeat",
              relayDatabaseLogsHeartbeatSchema.parse({
                attachmentIds: [attachmentId],
              }),
              10_000,
              user.id
            )
          )
          if (renewed.unknown.includes(attachmentId)) {
            finish({
              code: "detached",
              message: "The Relay stopped following the database",
              type: "error",
            })
          }
        }, fail)
      }, HEARTBEAT_INTERVAL_MS)
    )
    // After the timers exist, so an ending among these clears them too.
    for (const output of early.splice(0)) deliver(output)
  }, fail)

  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      while (queued.length === 0 && !closed) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        wake = null
      }
      const record = queued.shift()
      if (record?.type === "lines") queuedLines -= record.lines.length
      if (record) {
        controller.enqueue(encoder.encode(`${JSON.stringify(record)}\n`))
        return
      }
      controller.close()
    },
    cancel: () => {
      leave()
    },
  })
}

async function stillAuthorized(input: {
  authSessionId: string
  databaseId: string
  headers: Headers
  relay: PersistedRelay
}) {
  const identity = await getAuthenticatedRealtimeIdentityFromHeaders(
    input.headers
  )
  if (
    !identity ||
    identity.sessionId !== input.authSessionId ||
    !isEligibleAccount(identity.user)
  ) {
    return false
  }
  await requireRelayPermission({
    databaseId: input.databaseId,
    permission: "database.logs.read",
    relayId: input.relay.id,
    user: identity.user,
  })
  return true
}

function streamErrorCode(cause: unknown): DatabaseLogsStreamError {
  // Operation errors carry the Relay's code; connection failures don't.
  return cause instanceof RelayUnavailableError && cause.code === undefined
    ? "relay-unavailable"
    : "failed"
}
