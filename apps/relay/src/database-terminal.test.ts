import { createRequire } from "node:module"

import {
  relayCreateDatabaseSchema,
  type DatabaseTerminalEnd,
  type HearthDatabaseTerminalOutput,
  type RelayDatabaseTerminalAttached,
} from "@workspace/contracts"
import type { ITerminalAddon } from "@xterm/headless"
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
// A Hearth viewer: collects the output and ending pushed to it. A held
// viewer doesn't answer pushes until released, like a slow page.
function viewer(accepting = true, options: { held?: boolean } = {}) {
  const pushes: Array<HearthDatabaseTerminalOutput> = []
  let release = () => {}
  const released = options.held
    ? new Promise<void>((resolve) => {
        release = resolve
      })
    : Promise.resolve()
  return {
    pushes,
    release: () => release(),
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
      await released
      return { accepted: accepting }
    },
  }
}

// Rebuilds the screen a page shows from its snapshot and the pushes after
// it, the way the browser does, as escape sequences that redraw it.
const require = createRequire(import.meta.url)
const { Terminal } =
  require("@xterm/headless") as typeof import("@xterm/headless")
const { SerializeAddon } = require("@xterm/addon-serialize") as {
  SerializeAddon: new () => ITerminalAddon & {
    serialize(options?: { scrollback?: number }): string
  }
}
function pageScreen(
  attached: RelayDatabaseTerminalAttached,
  pushes: ReadonlyArray<HearthDatabaseTerminalOutput> = []
) {
  const screen = new Terminal({
    allowProposedApi: true,
    cols: attached.cols,
    rows: attached.rows,
    scrollback: 2_000,
  })
  const serializer = new SerializeAddon()
  screen.loadAddon(serializer)
  screen.write(attached.snapshot)
  let offset = attached.offset
  for (const push of pushes) {
    const { cols, rows } = push
    screen.write("", () => {
      if (screen.cols !== cols || screen.rows !== rows) {
        screen.resize(cols, rows)
      }
    })
    const data = Buffer.from(push.data, "base64")
    screen.write(
      data.subarray(Math.max(0, offset - (push.offset - data.length)))
    )
    offset = Math.max(offset, push.offset)
  }
  return new Promise<string>((resolve) => {
    screen.write("", () => resolve(serializer.serialize({ scrollback: 2_000 })))
  })
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
  options: { cols?: number; rows?: number } = {}
) {
  attachments += 1
  return terminals.attach(
    owner,
    database,
    {
      ...credentials,
      attachmentId: attachmentId(attachments),
      cols: options.cols ?? 80,
      databaseId,
      idleTimeoutMs,
      rows: options.rows ?? 24,
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

  it("shows every page the session at one size, changing where its output did", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    const first = await attach(terminals, alice, database, viewer())
    const other = viewer()
    const joined = await attach(terminals, alice, database, other, {
      cols: 120,
      rows: 40,
    })
    const otherAttachment = attachmentId(attachments)
    // Joining shows the session as it is rather than resizing it.
    expect(joined).toMatchObject({ cols: 80, rows: 24 })

    terminals.write(alice, databaseId, first.sessionId, "before;")
    await vi.waitFor(() => expect(other.output).toContain("before;"))
    await terminals.claim(
      alice,
      databaseId,
      first.sessionId,
      otherAttachment,
      40,
      120
    )
    terminals.write(alice, databaseId, first.sessionId, "after;")
    await vi.waitFor(() => expect(other.output).toContain("after;"))

    const shownAt = (text: string) =>
      other.pushes
        .filter((push) =>
          Buffer.from(push.data, "base64").toString("utf8").includes(text)
        )
        .map(({ cols, rows }) => ({ cols, rows }))
    expect(shownAt("before;")).toEqual([{ cols: 80, rows: 24 }])
    expect(shownAt("after;")).toEqual([{ cols: 120, rows: 40 }])
    expect(clientExecs()[0]?.size).toEqual({ cols: 120, rows: 40 })
  })

  it("puts one of a person's pages in control at a time", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    const laptop = viewer()
    const session = await attach(terminals, alice, database, laptop)
    const laptopAttachment = attachmentId(attachments)
    const phone = viewer()
    await attach(terminals, alice, database, phone)
    const phoneAttachment = attachmentId(attachments)
    const control = (page: ReturnType<typeof viewer>) =>
      page.pushes.at(-1)?.control
    const claim = (attachment: string, cols: number) =>
      terminals.claim(
        alice,
        databaseId,
        session.sessionId,
        attachment,
        24,
        cols
      )

    await claim(laptopAttachment, 120)
    await vi.waitFor(() => {
      expect(control(laptop)).toBe("self")
      expect(control(phone)).toBe("other")
    })

    await claim(phoneAttachment, 40)
    await vi.waitFor(() => {
      expect(control(phone)).toBe("self")
      expect(control(laptop)).toBe("other")
      expect(laptop.pushes.at(-1)?.cols).toBe(40)
    })

    // The page in control leaving leaves nobody in control.
    terminals.detach(alice, phoneAttachment)
    await vi.waitFor(() => expect(control(laptop)).toBe("none"))

    // Someone else's page can't take control of this session.
    await expect(
      terminals.claim(
        mallory,
        databaseId,
        session.sessionId,
        laptopAttachment,
        24,
        80
      )
    ).rejects.toThrow()
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

    await terminals.restart(alice, databaseId)
    const second = await attach(terminals, alice, database, viewer())

    expect(second.sessionId).not.toBe(first.sessionId)
    await vi.waitFor(() => expect(open.ended?.reason).toBe("restarted"))
    await vi.waitFor(() =>
      expect(clientExecs().filter((exec) => exec.running)).toHaveLength(1)
    )
  })

  it("shows a slow page every resize, even ones with no output between them", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    const slow = viewer(true, { held: true })
    const slowAttached = await attach(terminals, alice, database, slow)
    const slowAttachment = attachmentId(attachments)
    const phone = viewer()
    await attach(terminals, alice, database, phone)
    const phoneAttachment = attachmentId(attachments)
    for (let line = 1; line <= 30; line += 1) {
      terminals.write(
        alice,
        databaseId,
        slowAttached.sessionId,
        `line ${line} ${"x".repeat(60)}\r\n`
      )
    }
    // With the cursor back at the top, shrinking the screen drops the lines
    // below it rather than scrolling them away.
    terminals.write(alice, databaseId, slowAttached.sessionId, "\u001b[H")
    await vi.waitFor(() => expect(phone.output).toContain("\u001b[H"))

    // While the slow page is still catching up, the size goes to a small
    // window and back, with no output in between.
    const claim = (attachment: string, cols: number, rows: number) =>
      terminals.claim(
        alice,
        databaseId,
        slowAttached.sessionId,
        attachment,
        rows,
        cols
      )
    await claim(phoneAttachment, 40, 4)
    await claim(slowAttachment, 80, 24)
    slow.release()
    await vi.waitFor(() =>
      expect(slow.pushes.at(-1)).toMatchObject({ cols: 80, control: "self" })
    )

    const fresh = await attach(terminals, alice, database, viewer())
    expect(await pageScreen(slowAttached, slow.pushes)).toBe(
      await pageScreen(fresh)
    )
  })

  it("shows a page that opens mid escape sequence the same screen", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    const first = viewer()
    const firstAttached = await attach(terminals, alice, database, first)
    const { sessionId } = firstAttached

    // The colour sequence arrives split around the second page opening.
    terminals.write(alice, databaseId, sessionId, "\u001b[31")
    await vi.waitFor(() => expect(first.output).toContain("\u001b[31"))
    const second = viewer()
    const secondAttached = await attach(terminals, alice, database, second)
    terminals.write(alice, databaseId, sessionId, "mhello")
    await vi.waitFor(() => expect(second.output).toContain("hello"))

    const expected = await pageScreen(firstAttached, first.pushes)
    // "hello" in red, not the sequence's tail printed as text.
    expect(expected).toContain("\u001b[31mhello")
    expect(await pageScreen(secondAttached, second.pushes)).toBe(expected)
  })

  it("shows output the client printed as Docker started it", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    fakeDocker.execGreeting = "kiln_app=# "

    const page = viewer()
    const session = await attach(
      new DatabaseTerminals(harness.config),
      alice,
      database,
      page
    )

    // The page shows it, from the snapshot or the output that follows.
    await vi.waitFor(() =>
      expect(session.snapshot + page.output).toContain("kiln_app=# ")
    )
  })

  it("keeps a replacement session working when the old one finishes ending late", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    const old = viewer()
    const first = await attach(terminals, alice, database, old)
    const inspection = fakeDocker.hold({ command: "inspect" })
    const cleanups = () =>
      [...fakeDocker.execs.values()].filter((exec) =>
        exec.cmd.join(" ").includes("rm -f")
      ).length

    // The client exits: its socket ends and closes, and the first ending
    // waits on the container inspection.
    fakeDocker.exitExec(clientExecs()[0]!.id)
    await inspection.reached
    await vi.waitFor(() =>
      expect(() =>
        terminals.write(alice, databaseId, first.sessionId, "x")
      ).toThrow("The terminal session has ended")
    )
    const replacing = attach(terminals, alice, database, viewer())
    const cleanupsBefore = cleanups()
    inspection.release()
    const replacement = await replacing
    // Every ending of the old session has finished.
    await vi.waitFor(() => expect(cleanups()).toBeGreaterThan(cleanupsBefore))
    await vi.waitFor(() => expect(old.ended?.reason).toBe("exited"))

    expect(replacement.sessionId).not.toBe(first.sessionId)
    expect(
      terminals.write(alice, databaseId, replacement.sessionId, "select 1;")
    ).toEqual({ accepted: true })
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
