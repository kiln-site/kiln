import { randomBytes } from "node:crypto"

import {
  relayDatabaseTerminalAttachedSchema,
  relayDatabaseTerminalHeartbeatSchema,
  type HearthDatabaseTerminalOutput,
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
  DatabaseTerminalStreamError,
  DatabaseTerminalStreamRecord,
} from "@/lib/database-terminal-stream"
import { databaseTerminalIdleTimeoutMs } from "@/lib/environment"
import { subscribeRealtimeChanges } from "@/lib/realtime-source.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { registerDatabaseTerminalAttachment } from "@/server/database-terminal-hub"
import {
  databaseRpc,
  requiredCredential,
} from "@/server/managed-database-access"

// Renewals keep this page's viewer on the Relay, which drops viewers it
// hasn't heard from in a minute.
const HEARTBEAT_INTERVAL_MS = 20_000
const PING_INTERVAL_MS = 15_000
// Output a page hasn't read yet, in base64 characters. A page that falls this
// far behind is detached; it reattaches from a fresh snapshot.
const MAX_QUEUED_CHARACTERS = 2_000_000

const encoder = new TextEncoder()

// Attaches one page to the person's terminal session and streams it as NDJSON
// records until the page leaves, the session ends, or the Relay is lost.
export function openDatabaseTerminalStream(input: {
  // The person's sign-in: its id, and the request headers that carry it, so
  // access can be checked again while the stream stays open.
  authSessionId: string
  cols: number
  databaseId: string
  headers: Headers
  relay: PersistedRelay
  restart: boolean
  rows: number
  signal: AbortSignal
  user: AuthenticatedUser
}): ReadableStream<Uint8Array> {
  const { databaseId, relay, user } = input
  const attachmentId = randomBytes(24).toString("base64url")
  const queued: Array<DatabaseTerminalStreamRecord> = []
  let queuedCharacters = 0
  // Pushes can reach Hearth before the attach reply; they wait behind it.
  const early: Array<HearthDatabaseTerminalOutput> = []
  let attached = false
  let closed = false
  let wake: (() => void) | null = null
  const timers: Array<ReturnType<typeof setInterval>> = []

  const send = (record: DatabaseTerminalStreamRecord) => {
    if (closed) return
    if (record.type === "output") {
      queuedCharacters += record.data.length
      if (queuedCharacters > MAX_QUEUED_CHARACTERS) {
        queued.length = 0
        queuedCharacters = 0
        leave({
          code: "detached",
          message: "This page fell behind the session",
          type: "error",
        })
        return
      }
    }
    queued.push(record)
    wake?.()
  }
  const finish = (record?: DatabaseTerminalStreamRecord) => {
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
          : "The terminal connection failed",
      type: "error",
    })
  const deliver = (output: HearthDatabaseTerminalOutput) => {
    if (!attached) {
      early.push(output)
      return
    }
    if (output.data) {
      send({ data: output.data, offset: output.offset, type: "output" })
    }
    if (output.ended) finish({ ended: output.ended, type: "ended" })
  }
  const unregister = registerDatabaseTerminalAttachment(
    attachmentId,
    relay.id,
    deliver
  )
  // A page that leaves stops being a viewer now rather than at expiry, so
  // the idle timeout starts from when it actually closed.
  const leave = (record?: DatabaseTerminalStreamRecord) => {
    const wasOpen = !closed
    finish(record)
    if (wasOpen) {
      forkPromise(() =>
        databaseRpc(
          relay,
          "database.terminal.detach",
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
        message: "Checking access to this terminal again",
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
    const credential = await requiredCredential(relay.id, databaseId)
    const session = relayDatabaseTerminalAttachedSchema.parse(
      await databaseRpc(
        relay,
        "database.terminal.attach",
        {
          attachmentId,
          cols: input.cols,
          databaseId,
          idleTimeoutMs: databaseTerminalIdleTimeoutMs(),
          password: credential.password,
          restart: input.restart,
          rows: input.rows,
          username: credential.username,
        },
        30_000,
        user.id
      )
    )
    if (closed) return
    send({ ...session, type: "attached", user: credential.username })
    attached = true
    for (const output of early.splice(0)) deliver(output)
    timers.push(
      setInterval(() => send({ type: "ping" }), PING_INTERVAL_MS),
      setInterval(() => {
        recheck()
        forkPromise(async () => {
          const renewed = z.object({ unknown: z.array(z.string()) }).parse(
            await databaseRpc(
              relay,
              "database.terminal.heartbeat",
              relayDatabaseTerminalHeartbeatSchema.parse({
                attachmentIds: [attachmentId],
              }),
              10_000,
              user.id
            )
          )
          if (renewed.unknown.includes(attachmentId)) {
            finish({
              code: "detached",
              message: "The Relay stopped sending this session",
              type: "error",
            })
          }
        }, fail)
      }, HEARTBEAT_INTERVAL_MS)
    )
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
      if (record?.type === "output") queuedCharacters -= record.data.length
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
    permission: "database.terminal",
    relayId: input.relay.id,
    user: identity.user,
  })
  return true
}

function streamErrorCode(cause: unknown): DatabaseTerminalStreamError {
  if (cause instanceof RelayUnavailableError) {
    // Operation errors carry the Relay's code; connection failures don't.
    if (cause.code === undefined) return "relay-unavailable"
    return cause.message.includes("Start the database")
      ? "not-running"
      : "failed"
  }
  return "failed"
}
