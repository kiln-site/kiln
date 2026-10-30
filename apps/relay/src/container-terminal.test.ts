import {
  relayCreateDatabaseSchema,
  type DatabaseEngine,
  type DatabaseTerminalEnd,
  type HearthDatabaseTerminalOutput,
} from "@workspace/contracts"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import {
  ContainerTerminals,
  databaseTerminalTarget,
} from "./container-terminal.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, type RelayHarness } from "./test/relay.js"

const databaseId = "e".repeat(40)
const password = "correct-horse-battery-staple-1"
const credentials = { password, username: "kiln_user" }
const alice = "hearth:alice"
const mallory = "hearth:mallory"
const idleTimeoutMs = 15 * 60_000

async function runningDatabase(
  harness: RelayHarness,
  engine: DatabaseEngine = "postgres"
) {
  await harness.databases.create(
    relayCreateDatabaseSchema.parse({
      databaseName: "kiln_app",
      engine,
      id: databaseId,
      name: "Main database",
      ...credentials,
    })
  )
  return harness.databases.target(databaseId)
}

// A Hearth viewer: collects the output and ending pushed to it.
function viewer() {
  const pushes: Array<HearthDatabaseTerminalOutput> = []
  return {
    get ended(): DatabaseTerminalEnd | null {
      return pushes.find((push) => push.ended)?.ended ?? null
    },
    push: async (output: HearthDatabaseTerminalOutput) => {
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
    databaseTerminalTarget(
      database,
      credentials.username,
      credentials.password
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

describe("database terminal sessions", () => {
  it("keeps each person's session to themselves", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new ContainerTerminals(harness.config)
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
      new ContainerTerminals(harness.config),
      alice,
      database,
      viewer()
    )

    const [client] = clientExecs()
    expect(client?.cmd.join(" ")).not.toContain(password)
    expect(client?.env.PGPASSWORD).toBe(password)
  })

  // valkey-cli reads REDISCLI_AUTH, like redis-cli; any other variable
  // opened an unauthenticated client.
  it.each(["redis", "valkey"] as const)(
    "signs the %s client in with the variable it reads",
    async (engine) => {
      const harness = await relayHarness()
      const database = await runningDatabase(harness, engine)
      await attach(
        new ContainerTerminals(harness.config),
        alice,
        database,
        viewer()
      )

      const [client] = clientExecs()
      expect(client?.cmd.join(" ")).not.toContain(password)
      expect(client?.env.REDISCLI_AUTH).toBe(password)
    }
  )

  it("ends everyone's sessions on a database being deleted, so its client can't write to it", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new ContainerTerminals(harness.config)
    const first = viewer()
    const second = viewer()
    await attach(terminals, alice, database, first)
    await attach(terminals, "bob", database, second)

    await terminals.endTarget(databaseId, database.containerId)

    await vi.waitFor(() => expect(first.ended?.reason).toBe("deleting"))
    await vi.waitFor(() => expect(second.ended?.reason).toBe("deleting"))
    await vi.waitFor(() =>
      expect(clientExecs().filter((exec) => exec.running)).toHaveLength(0)
    )
  })
})
