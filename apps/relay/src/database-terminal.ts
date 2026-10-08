import { randomBytes } from "node:crypto"
import { request } from "node:http"
import { createRequire } from "node:module"
import type { Duplex } from "node:stream"

import type {
  DatabaseTerminalEnd,
  DatabaseTerminalEndReason,
  HearthDatabaseTerminalOutput,
  RelayDatabaseTerminalAttach,
  RelayDatabaseTerminalAttached,
  RelayManagedDatabase,
} from "@workspace/contracts"
import type { ITerminalAddon, Terminal } from "@xterm/headless"
import { Result } from "effect"

import type { RelayConfig } from "./config.js"
import { forkPromise, recoverPromise } from "./effect/promise.js"

// Each person gets one terminal session per database. It belongs to the Relay,
// so it outlives tabs, devices, and Hearth restarts: Hearth attaches viewers,
// the Relay pushes their output to Hearth, and a session nobody views ends
// after its idle timeout. Relay restarts end every session.

// Sessions keep a terminal's memory each, so a Relay holds a bounded number.
const MAX_SESSIONS = 64
// Lines a newly attached viewer gets back, and the most raw output kept for a
// viewer that falls behind before it is sent a fresh snapshot instead.
const SCROLLBACK_LINES = 2_000
const OUTPUT_HISTORY_BYTES = 512 * 1024
// Snapshots travel in one control frame (1 MB), alongside the attach reply.
const MAX_SNAPSHOT_CHARACTERS = 600_000
const MAX_PUSH_BYTES = 64 * 1024
const PUSH_TIMEOUT_MS = 10_000
// Hearth renews each viewer while its page is open; one that stops renewing
// (Hearth stopped or lost the Relay) is dropped and the idle timeout starts.
export const VIEWER_EXPIRES_AFTER_MS = 60_000
const VIEWER_SWEEP_INTERVAL_MS = 15_000
// Ended sessions are remembered so the next one can say why the last ended.
const MAX_REMEMBERED_ENDINGS = 1_000
// Each client records its PID here so the Relay can hang it up: Docker keeps
// an exec running after its connection closes.
const PID_FILE_PREFIX = "/tmp/.kiln-terminal-"
// Hang up first so the client can restore its terminal; psql's readline
// catches SIGHUP and SIGTERM and may stay, so it is killed after a second.
const HANG_UP_FUNCTION =
  'hang_up() { pid=$(cat "$1") && kill -HUP "$pid" 2>/dev/null && sleep 1 && kill -KILL "$pid" 2>/dev/null; rm -f "$1"; }'
// Both packages ship UMD bundles that ESM loaders don't all unwrap the same
// way, so they load through Node's own CommonJS loader.
const require = createRequire(import.meta.url)
const { Terminal: HeadlessTerminal } =
  require("@xterm/headless") as typeof import("@xterm/headless")
// Typed here: the addon's own typings import the browser @xterm/xterm,
// which would bring DOM types into the Relay.
interface SerializeAddon extends ITerminalAddon {
  serialize(options?: { scrollback?: number }): string
}
const { SerializeAddon: HeadlessSerializeAddon } =
  require("@xterm/addon-serialize") as {
    SerializeAddon: new () => SerializeAddon
  }

// Distinguishes this Relay process's sessions from a previous one's.
const BOOT_ID = randomBytes(6).toString("base64url")

export type PushTerminalOutput = (
  output: HearthDatabaseTerminalOutput,
  timeoutMs: number
) => Promise<unknown>

interface Viewer {
  owner: string
  push: PushTerminalOutput
  renewedAt: number
  sending: boolean
  // Output up to here has been delivered to this viewer.
  sentOffset: number
}

interface TerminalSession {
  containerId: string
  databaseId: string
  ending: DatabaseTerminalEndReason | null
  ended: DatabaseTerminalEnd | null
  execId: string
  // Raw output from `historyStart`, for viewers catching up between pushes.
  history: Buffer
  historyStart: number
  id: string
  idleTimeoutMs: number
  idleTimer: ReturnType<typeof setTimeout> | null
  key: string
  // Output the screen has fully processed; snapshots cover exactly this.
  parsedOffset: number
  pidFile: string
  previous: DatabaseTerminalEnd | null
  screen: Terminal
  serializer: SerializeAddon
  socket: Duplex
  startedAt: string
  viewers: Map<string, Viewer>
}

export class DatabaseTerminals {
  readonly #config: Pick<RelayConfig, "dockerSocket">
  readonly #sessions = new Map<string, TerminalSession>()
  readonly #attachments = new Map<string, TerminalSession>()
  readonly #endings = new Map<string, DatabaseTerminalEnd>()
  #sweeper: ReturnType<typeof setInterval> | null = null

  constructor(config: Pick<RelayConfig, "dockerSocket">) {
    this.#config = config
  }

  async attach(
    owner: string,
    database: RelayManagedDatabase,
    input: RelayDatabaseTerminalAttach,
    push: PushTerminalOutput
  ): Promise<RelayDatabaseTerminalAttached> {
    const key = sessionKey(owner, database.id)
    let session = this.#sessions.get(key)
    if (session && input.restart) {
      await this.#end(session, "restarted")
      session = undefined
    }
    session ??= await this.#start(key, database, input)
    session.idleTimeoutMs = input.idleTimeoutMs
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = null
    // The newest viewer's window decides the size; the screen reflows to it
    // so its snapshot fits.
    if (
      input.cols !== session.screen.cols ||
      input.rows !== session.screen.rows
    ) {
      await this.#resize(session, input.rows, input.cols)
    }
    const snapshot = await serializeScreen(session)
    session.viewers.set(input.attachmentId, {
      owner,
      push,
      renewedAt: Date.now(),
      sending: false,
      sentOffset: snapshot.offset,
    })
    this.#attachments.set(input.attachmentId, session)
    this.#startSweeper()
    this.#flush(session)
    return {
      cols: session.screen.cols,
      offset: snapshot.offset,
      previous: session.previous,
      rows: session.screen.rows,
      sessionId: session.id,
      snapshot: snapshot.content,
      startedAt: session.startedAt,
    }
  }

  // Returns the attachments the Relay no longer has, so Hearth can reattach.
  heartbeat(owner: string, attachmentIds: ReadonlyArray<string>) {
    const now = Date.now()
    const unknown: Array<string> = []
    for (const attachmentId of attachmentIds) {
      const viewer = this.#attachments
        .get(attachmentId)
        ?.viewers.get(attachmentId)
      if (viewer && viewer.owner === owner) viewer.renewedAt = now
      else unknown.push(attachmentId)
    }
    return { unknown }
  }

  detach(owner: string, attachmentId: string) {
    const session = this.#attachments.get(attachmentId)
    if (session?.viewers.get(attachmentId)?.owner === owner) {
      this.#dropViewer(session, attachmentId)
    }
    return { detached: true }
  }

  write(owner: string, databaseId: string, sessionId: string, data: string) {
    const session = this.#current(owner, databaseId, sessionId)
    session.socket.write(data)
    return { accepted: true }
  }

  async resize(
    owner: string,
    databaseId: string,
    sessionId: string,
    rows: number,
    cols: number
  ) {
    await this.#resize(this.#current(owner, databaseId, sessionId), rows, cols)
    return { resized: true }
  }

  #current(owner: string, databaseId: string, sessionId: string) {
    const session = this.#sessions.get(sessionKey(owner, databaseId))
    // Another person's session is indistinguishable from a missing one.
    if (!session || session.id !== sessionId || session.ending) {
      throw new Error("The terminal session has ended")
    }
    return session
  }

  async #start(
    key: string,
    database: RelayManagedDatabase,
    input: RelayDatabaseTerminalAttach
  ) {
    const containerId = database.containerId
    if (!containerId || database.observedState !== "running") {
      throw new Error("Start the database to open its terminal")
    }
    if (this.#sessions.size >= MAX_SESSIONS) {
      throw new Error(
        "This Relay has too many open database terminals. Try again later."
      )
    }
    const sessionId = `${BOOT_ID}.${randomBytes(18).toString("base64url")}`
    const pidFile = `${PID_FILE_PREFIX}${sessionId}`
    const client = terminalClient(database, input.username, input.password)
    const created = await this.#dockerJson<{ Id: string }>(
      "POST",
      `/containers/${encodeURIComponent(containerId)}/exec`,
      {
        AttachStderr: true,
        AttachStdin: true,
        AttachStdout: true,
        Cmd: [
          "sh",
          "-c",
          'echo $$ > "$0" && exec "$@"',
          pidFile,
          ...client.command,
        ],
        Env: [...client.environment, "TERM=xterm-256color", "LANG=C.UTF-8"],
        Tty: true,
      }
    )
    const socket = await this.#startExec(created.Id, input.rows, input.cols)
    const screen = new HeadlessTerminal({
      allowProposedApi: true,
      cols: input.cols,
      rows: input.rows,
      scrollback: SCROLLBACK_LINES,
    })
    const serializer = new HeadlessSerializeAddon()
    screen.loadAddon(serializer)
    const session: TerminalSession = {
      containerId,
      databaseId: database.id,
      ended: null,
      ending: null,
      execId: created.Id,
      history: Buffer.alloc(0),
      historyStart: 0,
      id: sessionId,
      idleTimeoutMs: input.idleTimeoutMs,
      idleTimer: null,
      key,
      parsedOffset: 0,
      pidFile,
      previous: this.#endings.get(key) ?? null,
      screen,
      serializer,
      socket,
      startedAt: new Date().toISOString(),
      viewers: new Map(),
    }
    socket.on("data", (chunk: Buffer) => {
      const history = Buffer.concat([session.history, chunk])
      const overflow = Math.max(0, history.length - OUTPUT_HISTORY_BYTES)
      session.history = history.subarray(overflow)
      session.historyStart += overflow
      screen.write(chunk, () => {
        session.parsedOffset += chunk.length
      })
      this.#flush(session)
    })
    const exited = () => {
      forkPromise(() => this.#end(session, null))
    }
    socket.once("end", exited)
    socket.once("close", exited)
    socket.once("error", exited)
    this.#sessions.set(key, session)
    this.#endings.delete(key)
    return session
  }

  // Ends a session for `reason`, or works out why it ended on its own.
  async #end(
    session: TerminalSession,
    reason: DatabaseTerminalEndReason | null
  ) {
    if (session.ending || this.#sessions.get(session.key) !== session) return
    // A client that exited on its own has nothing left to hang up, and its
    // PID may already belong to another process.
    const hangUp = reason !== null
    session.ending =
      reason ??
      ((await this.#containerRunning(session)) ? "exited" : "database-stopped")
    session.ended = { at: new Date().toISOString(), reason: session.ending }
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.socket.destroy()
    this.#sessions.delete(session.key)
    this.#endings.set(session.key, session.ended)
    if (this.#endings.size > MAX_REMEMBERED_ENDINGS) {
      const oldest = this.#endings.keys().next().value
      if (oldest !== undefined) this.#endings.delete(oldest)
    }
    // Viewers get the remaining output and then the ending.
    this.#flush(session)
    forkPromise(() =>
      this.#runDetached(session.containerId, [
        "sh",
        "-c",
        hangUp ? `${HANG_UP_FUNCTION}; hang_up "$0"` : 'rm -f "$0"',
        session.pidFile,
      ])
    )
  }

  // Sends each viewer the output it hasn't had, one push at a time per viewer.
  #flush(session: TerminalSession) {
    const end = session.historyStart + session.history.length
    for (const [attachmentId, viewer] of session.viewers) {
      if (viewer.sending) continue
      const behind = viewer.sentOffset < session.historyStart
      if (behind) {
        // Too far behind to catch up from raw output; it reattaches for a
        // fresh snapshot.
        this.#dropViewer(session, attachmentId)
        continue
      }
      const finished = session.ended !== null
      if (viewer.sentOffset >= end && !finished) continue
      const from = viewer.sentOffset - session.historyStart
      const chunk = session.history.subarray(from, from + MAX_PUSH_BYTES)
      const offset = viewer.sentOffset + chunk.length
      const last = finished && offset >= end
      viewer.sending = true
      forkPromise(async () => {
        const accepted = await recoverPromise(
          () =>
            viewer.push(
              {
                attachmentId,
                data: chunk.toString("base64"),
                ended: last ? session.ended : null,
                offset,
                sessionId: session.id,
              },
              PUSH_TIMEOUT_MS
            ),
          () => null
        )
        viewer.sending = false
        if (!isAccepted(accepted) || last) {
          this.#dropViewer(session, attachmentId)
          return
        }
        viewer.sentOffset = offset
        this.#flush(session)
      })
    }
  }

  #dropViewer(session: TerminalSession, attachmentId: string) {
    if (!session.viewers.delete(attachmentId)) return
    this.#attachments.delete(attachmentId)
    if (session.viewers.size > 0 || session.ending) return
    session.idleTimer = setTimeout(() => {
      forkPromise(() => this.#end(session, "timed-out"))
    }, session.idleTimeoutMs)
    session.idleTimer.unref()
  }

  #startSweeper() {
    if (this.#sweeper) return
    this.#sweeper = setInterval(() => {
      const expired = Date.now() - VIEWER_EXPIRES_AFTER_MS
      for (const session of this.#sessions.values()) {
        for (const [attachmentId, viewer] of session.viewers) {
          if (viewer.renewedAt < expired) {
            this.#dropViewer(session, attachmentId)
          }
        }
      }
      if (this.#sessions.size === 0 && this.#sweeper) {
        clearInterval(this.#sweeper)
        this.#sweeper = null
      }
    }, VIEWER_SWEEP_INTERVAL_MS)
    this.#sweeper.unref()
  }

  async #resize(session: TerminalSession, rows: number, cols: number) {
    session.screen.resize(cols, rows)
    await this.#dockerJson(
      "POST",
      `/exec/${encodeURIComponent(session.execId)}/resize?h=${rows}&w=${cols}`
    )
  }

  async #containerRunning(session: TerminalSession) {
    const state = await recoverPromise(
      () =>
        this.#dockerJson<{ State?: { Running?: boolean } }>(
          "GET",
          `/containers/${encodeURIComponent(session.containerId)}/json`
        ),
      () => null
    )
    return state?.State?.Running === true
  }

  // Clients left by a Relay that stopped while terminals were open.
  async sweep(databases: ReadonlyArray<RelayManagedDatabase>) {
    await Promise.all(
      databases.flatMap(({ containerId, observedState }) =>
        containerId && observedState === "running"
          ? [
              // One unreachable database shouldn't stop the others' sweep.
              recoverPromise(
                () =>
                  this.#runDetached(containerId, [
                    "sh",
                    "-c",
                    `${HANG_UP_FUNCTION}; for file in "$0"*; do [ -f "$file" ] && hang_up "$file"; done`,
                    PID_FILE_PREFIX,
                  ]),
                () => undefined
              ),
            ]
          : []
      )
    )
  }

  async #runDetached(containerId: string, command: Array<string>) {
    const created = await this.#dockerJson<{ Id: string }>(
      "POST",
      `/containers/${encodeURIComponent(containerId)}/exec`,
      { AttachStderr: false, AttachStdout: false, Cmd: command }
    )
    await this.#dockerJson(
      "POST",
      `/exec/${encodeURIComponent(created.Id)}/start`,
      { Detach: true }
    )
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

// The screen as escape sequences that rebuild it in an empty terminal, with
// as much scrollback as fits in one control frame.
function serializeScreen(session: TerminalSession) {
  return new Promise<{ content: string; offset: number }>((resolve) => {
    // An empty write runs its callback once earlier output is processed.
    session.screen.write("", () => {
      let scrollback = SCROLLBACK_LINES
      let content = session.serializer.serialize({ scrollback })
      while (content.length > MAX_SNAPSHOT_CHARACTERS && scrollback > 0) {
        scrollback = Math.floor(scrollback / 2)
        content = session.serializer.serialize({ scrollback })
      }
      resolve({ content, offset: session.parsedOffset })
    })
  })
}

function sessionKey(owner: string, databaseId: string) {
  return `${owner}\u0000${databaseId}`
}

function isAccepted(reply: unknown) {
  return (
    typeof reply === "object" &&
    reply !== null &&
    (reply as { accepted?: unknown }).accepted === true
  )
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
        // No pager: when the session hangs up, an orphaned pager is adopted
        // by the postmaster (PID 1), which restarts the server if it dies by
        // signal. The terminal keeps its own scrollback instead.
        command: [
          "psql",
          "--pset=pager=off",
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
