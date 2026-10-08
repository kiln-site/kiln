import { randomBytes } from "node:crypto"
import { request } from "node:http"
import type { Duplex } from "node:stream"

import type {
  RelayDatabaseTerminalOpen,
  RelayDatabaseTerminalOutput,
  RelayManagedDatabase,
} from "@workspace/contracts"

import { Result } from "effect"

import type { RelayConfig } from "./config.js"

// Terminal output reaches Hearth through long-polled reads on the control
// connection, which shares a small request budget with everything else.
// Capping sessions caps how much of that budget terminals can hold.
const MAX_SESSIONS = 4
const MAX_SESSIONS_PER_OWNER = 2
const READ_WAIT_MS = 10_000
const MAX_READ_BYTES = 64 * 1024
// Output kept for a reader that falls behind; older output is dropped.
const OUTPUT_HISTORY_BYTES = 256 * 1024
// A session nobody reads is abandoned: the browser closed or lost Hearth.
const ABANDONED_AFTER_MS = 45_000
const REAPER_INTERVAL_MS = 15_000

interface TerminalSession {
  closed: boolean
  containerId: string
  execId: string
  // Byte offset of `history[0]` in the session's whole output.
  historyStart: number
  history: Buffer
  lastRead: number
  owner: string
  socket: Duplex
  waiters: Set<() => void>
}

export class DatabaseTerminals {
  readonly #config: Pick<RelayConfig, "dockerSocket">
  readonly #sessions = new Map<string, TerminalSession>()
  #reaper: ReturnType<typeof setInterval> | null = null

  constructor(config: Pick<RelayConfig, "dockerSocket">) {
    this.#config = config
  }

  async open(
    owner: string,
    database: RelayManagedDatabase,
    input: RelayDatabaseTerminalOpen
  ): Promise<{ sessionId: string }> {
    const containerId = database.containerId
    if (!containerId || database.observedState !== "running") {
      throw new Error("Start the database to open its terminal")
    }
    if (this.#sessions.size >= MAX_SESSIONS) {
      throw new Error(
        "This Relay has too many open database terminals. Close one and try again."
      )
    }
    const owned = [...this.#sessions.values()].filter(
      (session) => session.owner === owner
    )
    if (owned.length >= MAX_SESSIONS_PER_OWNER) {
      throw new Error(
        "You already have two database terminals open. Close one and try again."
      )
    }
    const client = terminalClient(database, input.username, input.password)
    const created = await this.#dockerJson<{ Id: string }>(
      "POST",
      `/containers/${encodeURIComponent(containerId)}/exec`,
      {
        AttachStderr: true,
        AttachStdin: true,
        AttachStdout: true,
        Cmd: client.command,
        Env: [...client.environment, "TERM=xterm-256color", "LANG=C.UTF-8"],
        Tty: true,
      }
    )
    const socket = await this.#startExec(created.Id, input.rows, input.cols)
    const sessionId = randomBytes(24).toString("base64url")
    const session: TerminalSession = {
      closed: false,
      containerId,
      execId: created.Id,
      history: Buffer.alloc(0),
      historyStart: 0,
      lastRead: Date.now(),
      owner,
      socket,
      waiters: new Set(),
    }
    socket.on("data", (chunk: Buffer) => {
      const history = Buffer.concat([session.history, chunk])
      const overflow = Math.max(0, history.length - OUTPUT_HISTORY_BYTES)
      session.history = history.subarray(overflow)
      session.historyStart += overflow
      wake(session)
    })
    const end = () => {
      session.closed = true
      wake(session)
    }
    socket.once("end", end)
    socket.once("close", end)
    socket.once("error", end)
    this.#sessions.set(sessionId, session)
    this.#startReaper()
    return { sessionId }
  }

  async read(
    owner: string,
    sessionId: string,
    cursor: number,
    signal: AbortSignal
  ): Promise<RelayDatabaseTerminalOutput> {
    const session = this.#owned(owner, sessionId)
    session.lastRead = Date.now()
    const end = session.historyStart + session.history.length
    if (cursor >= end && !session.closed) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          signal.removeEventListener("abort", done)
          session.waiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, READ_WAIT_MS)
        signal.addEventListener("abort", done, { once: true })
        session.waiters.add(done)
      })
      session.lastRead = Date.now()
    }
    const from = Math.max(cursor, session.historyStart) - session.historyStart
    const chunk = session.history.subarray(from, from + MAX_READ_BYTES)
    const next = session.historyStart + from + chunk.length
    const drained = next >= session.historyStart + session.history.length
    if (session.closed && drained) this.#sessions.delete(sessionId)
    return {
      closed: session.closed && drained,
      cursor: next,
      data: chunk.toString("base64"),
    }
  }

  write(owner: string, sessionId: string, data: string) {
    const session = this.#owned(owner, sessionId)
    if (session.closed) throw new Error("The terminal session has ended")
    session.socket.write(data)
    return { accepted: true }
  }

  async resize(owner: string, sessionId: string, rows: number, cols: number) {
    const session = this.#owned(owner, sessionId)
    await this.#resize(session.execId, rows, cols)
    return { resized: true }
  }

  close(owner: string, sessionId: string) {
    const session = this.#sessions.get(sessionId)
    if (session && session.owner === owner) this.#end(sessionId, session)
    return { closed: true }
  }

  #owned(owner: string, sessionId: string) {
    const session = this.#sessions.get(sessionId)
    // Another owner's session is indistinguishable from a missing one.
    if (!session || session.owner !== owner) {
      throw new Error("The terminal session has ended")
    }
    return session
  }

  #end(sessionId: string, session: TerminalSession) {
    this.#sessions.delete(sessionId)
    session.closed = true
    // Closing the TTY hangs up the client inside the container.
    session.socket.destroy()
    wake(session)
    if (this.#sessions.size === 0) this.#stopReaper()
  }

  #startReaper() {
    if (this.#reaper) return
    this.#reaper = setInterval(() => {
      const now = Date.now()
      for (const [sessionId, session] of this.#sessions) {
        if (now - session.lastRead > ABANDONED_AFTER_MS) {
          this.#end(sessionId, session)
        }
      }
    }, REAPER_INTERVAL_MS)
    this.#reaper.unref()
  }

  #stopReaper() {
    if (this.#reaper) clearInterval(this.#reaper)
    this.#reaper = null
  }

  #startExec(execId: string, rows: number, cols: number) {
    return new Promise<Duplex>((resolve, reject) => {
      const body = JSON.stringify({
        ConsoleSize: [rows, cols],
        Detach: false,
        Tty: true,
      })
      const started = request({
        headers: {
          Connection: "Upgrade",
          "Content-Length": Buffer.byteLength(body),
          "Content-Type": "application/json",
          Upgrade: "tcp",
        },
        method: "POST",
        path: `/exec/${encodeURIComponent(execId)}/start`,
        socketPath: this.#config.dockerSocket,
      })
      const timer = setTimeout(() => {
        started.destroy(new Error("Docker exec did not start in time"))
      }, 10_000)
      started.on("upgrade", (_response, socket) => {
        clearTimeout(timer)
        resolve(socket)
      })
      started.on("response", (response) => {
        clearTimeout(timer)
        response.resume()
        reject(
          new Error(`Docker exec returned HTTP ${response.statusCode ?? 500}`)
        )
      })
      started.on("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      started.end(body)
    })
  }

  async #resize(execId: string, rows: number, cols: number) {
    await this.#dockerJson(
      "POST",
      `/exec/${encodeURIComponent(execId)}/resize?h=${rows}&w=${cols}`
    )
  }

  #dockerJson<TResult>(method: string, path: string, payload?: unknown) {
    return new Promise<TResult>((resolve, reject) => {
      const body = payload === undefined ? "" : JSON.stringify(payload)
      const call = request(
        {
          headers: {
            "Content-Length": Buffer.byteLength(body),
            "Content-Type": "application/json",
          },
          method,
          path,
          socketPath: this.#config.dockerSocket,
          timeout: 10_000,
        },
        (response) => {
          const chunks: Array<Buffer> = []
          response.on("data", (chunk: Buffer) => chunks.push(chunk))
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8")
            if ((response.statusCode ?? 500) >= 300) {
              reject(new Error(dockerMessage(text, response.statusCode)))
              return
            }
            const parsed = Result.try(
              () => (text ? JSON.parse(text) : null) as TResult
            )
            if (Result.isSuccess(parsed)) resolve(parsed.success)
            else reject(new Error("Docker returned an invalid response"))
          })
        }
      )
      call.on("timeout", () => call.destroy(new Error("Docker did not answer")))
      call.on("error", reject)
      call.end(body)
    })
  }
}

function wake(session: TerminalSession) {
  for (const waiter of session.waiters) waiter()
}

// The engine's own client, signed in as the database's user. Passwords go
// through the environment the clients read, never the command line.
function terminalClient(
  database: RelayManagedDatabase,
  username: string,
  password: string
): { command: Array<string>; environment: Array<string> } {
  switch (database.engine) {
    case "mysql":
    case "mariadb":
      return {
        command: [
          database.engine === "mysql" ? "mysql" : "mariadb",
          "--user",
          username,
          database.databaseName,
        ],
        environment: [`MYSQL_PWD=${password}`],
      }
    case "postgres":
      return {
        command: [
          "psql",
          "--username",
          username,
          "--dbname",
          database.databaseName,
        ],
        environment: [`PGPASSWORD=${password}`],
      }
    case "redis":
    case "valkey":
      return {
        command: [
          database.engine === "redis" ? "redis-cli" : "valkey-cli",
          "--user",
          username,
          "--no-auth-warning",
        ],
        environment: [
          `${database.engine === "redis" ? "REDISCLI_AUTH" : "VALKEYCLI_AUTH"}=${password}`,
        ],
      }
  }
}

function dockerMessage(text: string, status: number | undefined) {
  const parsed = Result.try(() => JSON.parse(text) as { message?: unknown })
  return Result.isSuccess(parsed) && typeof parsed.success?.message === "string"
    ? parsed.success.message
    : `Docker returned HTTP ${status ?? 500}`
}
