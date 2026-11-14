import {
  relayCreateDatabaseSchema,
  type HearthTerminalOutput,
  type TerminalEnd,
} from "@workspace/contracts"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import {
  ContainerTerminals,
  containerShell,
  terminalTargetKey,
} from "./container-terminal.js"
import { fakeDocker } from "./test/docker.js"
import { databaseBrick } from "./test/database-bricks.js"
import { relayHarness, type RelayHarness } from "./test/relay.js"

const databaseId = "e".repeat(12)
const target = { kind: "database", id: databaseId } as const
const targetKey = terminalTargetKey(target)
const alice = "hearth:alice"
const mallory = "hearth:mallory"
const idleTimeoutMs = 15 * 60_000

async function runningDatabase(harness: RelayHarness) {
  await harness.databases.create(
    relayCreateDatabaseSchema.parse({
      databaseName: "kiln_app",
      ...databaseBrick("postgres"),
      id: databaseId,
      name: "Main database",
      password: "correct-horse-battery-staple-1",
      username: "kiln_user",
    })
  )
  return harness.databases.target(databaseId)
}

// A Hearth viewer: collects the output and ending pushed to it.
function viewer() {
  const pushes: Array<HearthTerminalOutput> = []
  return {
    get ended(): TerminalEnd | null {
      return pushes.find((push) => push.ended)?.ended ?? null
    },
    push: async (output: HearthTerminalOutput) => {
      pushes.push(output)
      return { accepted: true }
    },
  }
}

let attachments = 0
function attachmentId(index: number) {
  return `attachment-${index}-${"x".repeat(24)}`
}

function attach(
  terminals: ContainerTerminals,
  owner: string,
  database: Awaited<ReturnType<typeof runningDatabase>>,
  watcher: ReturnType<typeof viewer>
) {
  attachments += 1
  return terminals.attach(
    owner,
    containerShell(
      target,
      { id: database.containerId!, running: true },
      "Start the database to open its terminal"
    ),
    {
      attachmentId: attachmentId(attachments),
      cols: 80,
      idleTimeoutMs,
      rows: 24,
    },
    watcher.push
  )
}

function clientExecs() {
  return [...fakeDocker.execs.values()].filter((exec) => exec.tty)
}

describe("terminal sessions", () => {
  it("keeps each person's session to themselves", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new ContainerTerminals(harness.config)
    const aliceSession = await attach(terminals, alice, database, viewer())
    const aliceAttachment = attachmentId(attachments)
    const mallorySession = await attach(terminals, mallory, database, viewer())

    expect(mallorySession.sessionId).not.toBe(aliceSession.sessionId)
    expect(() =>
      terminals.write(mallory, targetKey, aliceSession.sessionId, "exit\r")
    ).toThrow("The terminal session has ended")
    expect(
      terminals.heartbeat(mallory, targetKey, [aliceAttachment]).unknown
    ).toEqual([aliceAttachment])
  })

  // A request is authorized for the target it names, so it reaches no
  // attachment on another, even the same person's.
  it("keeps an attachment to the target it was opened on", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new ContainerTerminals(harness.config)
    const watcher = viewer()
    await attach(terminals, alice, database, watcher)
    const attachment = attachmentId(attachments)
    const elsewhere = terminalTargetKey({
      kind: "app",
      id: "a".repeat(12),
      service: "web",
    })

    expect(
      terminals.heartbeat(alice, elsewhere, [attachment]).unknown
    ).toEqual([attachment])
    terminals.detach(alice, elsewhere, attachment)
    expect(terminals.heartbeat(alice, targetKey, [attachment]).unknown).toEqual(
      []
    )
  })

  it("ends everyone's sessions on an instance being deleted, and hangs up their shells", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new ContainerTerminals(harness.config)
    const first = viewer()
    const second = viewer()
    await attach(terminals, alice, database, first)
    await attach(terminals, "bob", database, second)

    await terminals.endInstance(databaseId, [database.containerId!])

    await vi.waitFor(() => expect(first.ended?.reason).toBe("deleting"))
    await vi.waitFor(() => expect(second.ended?.reason).toBe("deleting"))
    await vi.waitFor(() =>
      expect(clientExecs().filter((exec) => exec.running)).toHaveLength(0)
    )
  })
})
