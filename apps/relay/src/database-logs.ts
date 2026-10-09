import {
  DATABASE_LOGS_PUSH_MAX_LINES,
  type HearthDatabaseLogsOutput,
  type RelayConsoleLine,
  type RelayManagedDatabase,
} from "@workspace/contracts"

import type { DockerDriver } from "./docker.js"
import { forkPromise, recoverPromise } from "./effect/promise.js"

// Each logs page open in Hearth follows the database container's output with
// its own `docker logs --follow`, and the Relay pushes the lines to Hearth.
// A follower ends when the container stops, when Hearth says the page is
// gone, or when Hearth stops renewing it.

// Lines a page starts with.
const HISTORY_LINES = 2_000
// Every follower is a process, so a Relay runs a bounded number.
const MAX_FOLLOWERS = 64
// Lines waiting for a page that isn't keeping up; older ones are dropped.
const MAX_QUEUED_LINES = 5_000
// Longer lines are cut, so any line fits in a push.
const MAX_LINE_CHARACTERS = 16 * 1024
// Pushes stay well under the 1 MB control frame.
const MAX_PUSH_CHARACTERS = 256 * 1024
const PUSH_TIMEOUT_MS = 10_000
// Lines arriving together, like the history, go in one push.
const PUSH_DELAY_MS = 25
// Hearth renews each follower while its page is open.
export const FOLLOWER_EXPIRES_AFTER_MS = 60_000
const SWEEP_INTERVAL_MS = 15_000

export type PushDatabaseLogs = (
  output: HearthDatabaseLogsOutput,
  timeoutMs: number
) => Promise<unknown>

interface Follower {
  abort: AbortController
  ended: HearthDatabaseLogsOutput["ended"]
  owner: string
  push: PushDatabaseLogs
  queued: Array<RelayConsoleLine>
  renewedAt: number
  sending: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export class DatabaseLogs {
  readonly #docker: Pick<DockerDriver, "streamContainerLogs">
  readonly #followers = new Map<string, Follower>()
  #sweeper: ReturnType<typeof setInterval> | null = null

  constructor(docker: Pick<DockerDriver, "streamContainerLogs">) {
    this.#docker = docker
  }

  attach(
    owner: string,
    database: RelayManagedDatabase,
    attachmentId: string,
    push: PushDatabaseLogs
  ) {
    const containerId = database.containerId
    if (!containerId) throw new Error("Database container ID is missing")
    if (this.#followers.has(attachmentId)) {
      throw new Error("This page is already following the database")
    }
    if (this.#followers.size >= MAX_FOLLOWERS) {
      throw new Error("Too many database logs are open on this Relay")
    }
    const follower: Follower = {
      abort: new AbortController(),
      ended: null,
      owner,
      push,
      queued: [],
      renewedAt: Date.now(),
      sending: false,
      timer: null,
    }
    this.#followers.set(attachmentId, follower)
    this.#startSweeper()
    forkPromise(() => this.#follow(attachmentId, follower, containerId))
    return { attached: true }
  }

  // Returns the attachments the Relay no longer has, so Hearth can reattach.
  heartbeat(owner: string, attachmentIds: ReadonlyArray<string>) {
    const now = Date.now()
    const unknown: Array<string> = []
    for (const attachmentId of attachmentIds) {
      const follower = this.#followers.get(attachmentId)
      if (follower?.owner === owner) follower.renewedAt = now
      else unknown.push(attachmentId)
    }
    return { unknown }
  }

  detach(owner: string, attachmentId: string) {
    if (this.#followers.get(attachmentId)?.owner === owner) {
      this.#drop(attachmentId)
    }
    return { detached: true }
  }

  close() {
    for (const attachmentId of this.#followers.keys()) {
      this.#drop(attachmentId)
    }
  }

  async #follow(attachmentId: string, follower: Follower, containerId: string) {
    const ended = await recoverPromise(
      async () => {
        for await (const line of this.#docker.streamContainerLogs(
          containerId,
          follower.abort.signal,
          HISTORY_LINES
        )) {
          follower.queued.push(
            line.text.length > MAX_LINE_CHARACTERS
              ? {
                  ...line,
                  segments: undefined,
                  text: line.text.slice(0, MAX_LINE_CHARACTERS),
                }
              : line
          )
          if (follower.queued.length > MAX_QUEUED_LINES) {
            follower.queued.splice(0, follower.queued.length - MAX_QUEUED_LINES)
          }
          this.#schedule(attachmentId, follower)
        }
        return "stopped" as const
      },
      () => "failed" as const
    )
    if (follower.abort.signal.aborted) return
    follower.ended = ended
    this.#schedule(attachmentId, follower)
  }

  #schedule(attachmentId: string, follower: Follower) {
    if (follower.sending || follower.timer) return
    follower.timer = setTimeout(() => {
      follower.timer = null
      this.#flush(attachmentId, follower)
    }, PUSH_DELAY_MS)
  }

  // Sends the follower's queued lines, one push at a time, and its ending
  // with the last of them.
  #flush(attachmentId: string, follower: Follower) {
    if (follower.sending || this.#followers.get(attachmentId) !== follower) {
      return
    }
    const lines = takePush(follower.queued)
    const ended = follower.queued.length === 0 ? follower.ended : null
    if (lines.length === 0 && !ended) return
    follower.sending = true
    forkPromise(async () => {
      const reply = await recoverPromise(
        () => follower.push({ attachmentId, ended, lines }, PUSH_TIMEOUT_MS),
        () => null
      )
      follower.sending = false
      // Hearth no longer has the page, or this was the last push.
      if (!isAccepted(reply) || ended) {
        this.#drop(attachmentId)
        return
      }
      this.#flush(attachmentId, follower)
    })
  }

  #drop(attachmentId: string) {
    const follower = this.#followers.get(attachmentId)
    if (!follower) return
    this.#followers.delete(attachmentId)
    follower.abort.abort()
    if (follower.timer) clearTimeout(follower.timer)
    follower.queued.length = 0
  }

  #startSweeper() {
    if (this.#sweeper) return
    this.#sweeper = setInterval(() => {
      const expired = Date.now() - FOLLOWER_EXPIRES_AFTER_MS
      for (const [attachmentId, follower] of this.#followers) {
        if (follower.renewedAt < expired) this.#drop(attachmentId)
      }
      if (this.#followers.size === 0 && this.#sweeper) {
        clearInterval(this.#sweeper)
        this.#sweeper = null
      }
    }, SWEEP_INTERVAL_MS)
    this.#sweeper.unref()
  }
}

function takePush(queued: Array<RelayConsoleLine>) {
  let count = 0
  let characters = 0
  while (count < queued.length && count < DATABASE_LOGS_PUSH_MAX_LINES) {
    characters += queued[count]!.text.length * 2
    if (count > 0 && characters > MAX_PUSH_CHARACTERS) break
    count += 1
  }
  return queued.splice(0, count)
}

function isAccepted(reply: unknown) {
  return (
    typeof reply === "object" &&
    reply !== null &&
    (reply as { accepted?: unknown }).accepted === true
  )
}
