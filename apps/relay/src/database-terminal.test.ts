import { relayCreateDatabaseSchema } from "@workspace/contracts"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { DatabaseTerminals } from "./database-terminal.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, type RelayHarness } from "./test/relay.js"

const databaseId = "e".repeat(40)
const password = "correct-horse-battery-staple-1"
const credentials = { password, username: "kiln_user" }
const alice = "hearth:alice"
const mallory = "hearth:mallory"

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

async function readUntil(
  terminals: DatabaseTerminals,
  sessionId: string,
  expected: string
) {
  let cursor = 0
  let output = ""
  while (!output.includes(expected)) {
    const read = await terminals.read(
      alice,
      sessionId,
      cursor,
      new AbortController().signal
    )
    output += Buffer.from(read.data, "base64").toString("utf8")
    cursor = read.cursor
  }
  return output
}

describe("database terminals", () => {
  it("keeps a session to the user who opened it", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    const { sessionId } = await terminals.open(alice, database, {
      ...credentials,
      cols: 80,
      databaseId,
      rows: 24,
    })

    expect(() =>
      terminals.write(mallory, sessionId, "DROP TABLE x;\r")
    ).toThrow("The terminal session has ended")
    await expect(
      terminals.read(mallory, sessionId, 0, new AbortController().signal)
    ).rejects.toThrow("The terminal session has ended")
    terminals.close(mallory, sessionId)

    terminals.write(alice, sessionId, "select 1;\r")
    expect(await readUntil(terminals, sessionId, "select 1;")).toBe(
      "select 1;\r"
    )
    terminals.close(alice, sessionId)
  })

  it("signs the client in without putting the password on its command line", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    const { sessionId } = await terminals.open(alice, database, {
      ...credentials,
      cols: 80,
      databaseId,
      rows: 24,
    })

    const [exec] = [...fakeDocker.execs.values()]
    expect(exec?.tty).toBe(true)
    expect(exec?.cmd.join(" ")).not.toContain(password)
    expect(exec?.env.PGPASSWORD).toBe(password)
    terminals.close(alice, sessionId)
  })

  it("ends the session when the client exits", async () => {
    const harness = await relayHarness()
    const database = await runningDatabase(harness)
    const terminals = new DatabaseTerminals(harness.config)
    const { sessionId } = await terminals.open(alice, database, {
      ...credentials,
      cols: 80,
      databaseId,
      rows: 24,
    })
    terminals.write(alice, sessionId, "\\q\r")
    await readUntil(terminals, sessionId, "\\q")

    const [exec] = [...fakeDocker.execs.values()]
    fakeDocker.exitExec(exec!.id)

    let read = await terminals.read(
      alice,
      sessionId,
      0,
      new AbortController().signal
    )
    while (!read.closed) {
      read = await terminals.read(
        alice,
        sessionId,
        read.cursor,
        new AbortController().signal
      )
    }
    expect(read.closed).toBe(true)
    expect(() => terminals.write(alice, sessionId, "select 1;\r")).toThrow(
      "The terminal session has ended"
    )
  })
})
