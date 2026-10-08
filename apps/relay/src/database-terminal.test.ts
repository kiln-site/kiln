import {
  relayCreateDatabaseSchema,
  type DatabaseTerminalEnd,
  type HearthDatabaseTerminalOutput,
} from "@workspace/contracts"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import {
  DatabaseTerminals,
  VIEWER_EXPIRES_AFTER_MS,
} from "./database-terminal.js"
import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"

const databaseId = "e".repeat(40)
const password = "correct-horse-battery-staple-1"
const credentials = { password, username: "kiln_user" }
const alice = "hearth:alice"
const mallory = "hearth:mallory"
const idleTimeoutMs = 15 * 60_000

afterEach(() => {
  vi.useRealTimers()
})

async function runningDatabase(harness: RelayHarness) {
  await harness.databases.create(
    relayCreateDatabaseSchema.parse({
      databaseName: "kiln_app",
      engine: "postgres",
      id: databaseId,
      name: "Main database",
      ...credentials,
    })
  )
  return harness.databases.target(databaseId)
}

// A Hearth viewer: collects the output and ending pushed to it.
function viewer(accepting = true) {
  const pushes: Array<HearthDatabaseTerminalOutput> = []
  return {
    get ended(): DatabaseTerminalEnd | null {
      return pushes.find((push) => push.ended)?.ended ?? null
    },
    get output() {
      return pushes
        .map((push) => Buffer.from(push.data, "base64").toString("utf8"))
        .join("")
    },
    push: async (output: HearthDatabaseTerminalOutput) => {
      pushes.push(output)
      return { accepted: accepting }
    },
  }
}

let attachments = 0
function attachmentId(index: number) {
  return `attachment-${index}-${"x".repeat(24)}`
}

function attach(
  terminals: DatabaseTerminals,
  owner: string,
  database: Awaited<ReturnType<typeof runningDatabase>>,
  watcher: ReturnType<typeof viewer>,
  options: { restart?: boolean } = {}
) {
  attachments += 1
  return terminals.attach(
    owner,
    database,
    {
      ...credentials,
      attachmentId: attachmentId(attachments),
      cols: 80,
      databaseId,
      idleTimeoutMs,
      restart: options.restart ?? false,
      rows: 24,
    },
    watcher.push
  )
}

// Under fake timers: runs due timers (the terminal parses output on them) and
// lets real I/O through until `promise` settles.
async function settled<T>(promise: Promise<T>) {
  let done = false
  const finish = () => {
    done = true
  }
  void promise.then(finish, finish)
  while (!done) {
    await vi.advanceTimersByTimeAsync(0)
    await new Promise((resolve) => setImmediate(resolve))
  }
  return promise
}

function clientExecs() {
  return [...fakeDocker.execs.values()].filter((exec) => exec.tty)
}

describe("database terminal sessions", () => {
  it("keeps one session per person and database that a new page picks up where the last left off", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    const first = viewer()
    const session = await attach(terminals, alice, database, first)

    terminals.write(alice, databaseId, session.sessionId, "select 1;")
    await vi.waitFor(() => expect(first.output).toContain("select 1;"))

    const again = await attach(terminals, alice, database, viewer())
    expect(again.sessionId).toBe(session.sessionId)
    expect(again.snapshot).toContain("select 1;")
    expect(clientExecs()).toHaveLength(1)
  })

  it("gives pages that open at the same time one shared session", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)

    const [first, second] = await Promise.all([
      attach(terminals, alice, database, viewer()),
      attach(terminals, alice, database, viewer()),
    ])

    expect(second.sessionId).toBe(first.sessionId)
    expect(clientExecs()).toHaveLength(1)
    expect(
      terminals.write(alice, databaseId, first.sessionId, "select 1;")
    ).toEqual({ accepted: true })
  })

  it("keeps each person's session to themselves", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    const aliceSession = await attach(terminals, alice, database, viewer())
    const aliceAttachment = attachmentId(attachments)
    const mallorySession = await attach(terminals, mallory, database, viewer())

    expect(mallorySession.sessionId).not.toBe(aliceSession.sessionId)
    expect(() =>
      terminals.write(mallory, databaseId, aliceSession.sessionId, "\\q\r")
    ).toThrow("The terminal session has ended")
    expect(terminals.heartbeat(mallory, [aliceAttachment]).unknown).toEqual([
      aliceAttachment,
    ])
  })

  it("passes the password through the client's environment, not its command line", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    await attach(
      new DatabaseTerminals(harness.config),
      alice,
      database,
      viewer()
    )

    const [client] = clientExecs()
    expect(client?.cmd.join(" ")).not.toContain(password)
    expect(client?.env.PGPASSWORD).toBe(password)
  })

  it("keeps running while a page is open and times out once none are", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    await attach(terminals, alice, database, viewer())
    const open = attachmentId(attachments)
    const [client] = clientExecs()

    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] })
    for (let elapsed = 0; elapsed < idleTimeoutMs * 2; elapsed += 30_000) {
      terminals.heartbeat(alice, [open])
      await vi.advanceTimersByTimeAsync(30_000)
    }
    expect(client?.running).toBe(true)

    terminals.detach(alice, open)
    await vi.advanceTimersByTimeAsync(idleTimeoutMs)
    vi.useRealTimers()
    await vi.waitFor(() => expect(client?.running).toBe(false))

    const next = await attach(terminals, alice, database, viewer())
    expect(next.previous?.reason).toBe("timed-out")
  })

  it("stops counting a page that stopped renewing as open", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] })
    await settled(attach(terminals, alice, database, viewer()))
    const [client] = clientExecs()

    // Expiry is checked periodically, so allow a second expiry window.
    await vi.advanceTimersByTimeAsync(
      2 * VIEWER_EXPIRES_AFTER_MS + idleTimeoutMs
    )
    vi.useRealTimers()

    await vi.waitFor(() => expect(client?.running).toBe(false))
  })

  it("drops a viewer Hearth no longer has, so the idle timeout starts", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    const gone = viewer(false)
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] })
    const session = await settled(attach(terminals, alice, database, gone))
    const [client] = clientExecs()

    terminals.write(alice, databaseId, session.sessionId, "x")
    await settled(vi.waitFor(() => expect(gone.output).toBe("x")))
    await vi.advanceTimersByTimeAsync(idleTimeoutMs)
    vi.useRealTimers()

    await vi.waitFor(() => expect(client?.running).toBe(false))
  })

  it("restarts into a new session and tells open pages the old one ended", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    const open = viewer()
    const first = await attach(terminals, alice, database, open)

    const second = await attach(terminals, alice, database, viewer(), {
      restart: true,
    })

    expect(second.sessionId).not.toBe(first.sessionId)
    await vi.waitFor(() => expect(open.ended?.reason).toBe("restarted"))
    await vi.waitFor(() =>
      expect(clientExecs().filter((exec) => exec.running)).toHaveLength(1)
    )
  })

  it("says why a session ended: its client exited, or the database stopped", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    const exiting = viewer()
    await attach(terminals, alice, database, exiting)
    fakeDocker.exitExec(clientExecs()[0]!.id)
    await vi.waitFor(() => expect(exiting.ended?.reason).toBe("exited"))

    const stopping = viewer()
    await attach(terminals, alice, database, stopping)
    fakeDocker.exit(`${TEST_NAMESPACE}-kiln-db-${databaseId}-database`, {
      exitCode: 0,
    })
    await vi.waitFor(() =>
      expect(stopping.ended?.reason).toBe("database-stopped")
    )
  })
})
