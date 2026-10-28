import { relayCreateDatabaseSchema } from "@workspace/contracts"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"
import { containerCommandOutputBytes } from "./container-commands.js"

const databaseId = "d".repeat(40)
const database = { id: databaseId, kind: "database" } as const

afterEach(() => {
  vi.useRealTimers()
})

async function databaseHarness() {
  const harness = await relayHarness()
  await harness.databases.create(
    relayCreateDatabaseSchema.parse({
      databaseName: "kiln_app",
      engine: "postgres",
      id: databaseId,
      name: "Main database",
      password: "correct-horse-battery-staple-1",
      username: "kiln_user",
    })
  )
  return harness
}

function databaseContainer() {
  const container = fakeDocker.container(
    `${TEST_NAMESPACE}-kiln-db-${databaseId}-database`
  )
  if (!container) throw new Error("The database has no container")
  return container
}

// What the command ran as, in the database's container.
function shellRuns(script: string) {
  return databaseContainer().processes.filter(
    (process) =>
      process.argv.join("\u0000") === ["sh", "-c", script].join("\u0000")
  )
}

describe("container commands", () => {
  it("answers with the exit code and the end of a long output", async () => {
    const harness = await databaseHarness()
    fakeDocker.shellScripts.set("./seed", {
      exitCode: 3,
      // Its last 4 KiB start inside a two-byte character.
      output: `${"é".repeat(10_000)}!\nseeded 12 rows\n`,
    })

    const result = await harness.commands.run(database, "./seed")

    expect(result).toMatchObject({ exitCode: 3, truncated: true, unknown: null })
    expect(result.output.endsWith("é!\nseeded 12 rows\n")).toBe(true)
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(
      containerCommandOutputBytes
    )
    // The cut never leaves half a character behind.
    expect(result.output).not.toContain("�")
    expect(shellRuns("./seed")).toHaveLength(1)
  })

  it("reports a command that outlives its timeout as unknown, and leaves it be", async () => {
    const harness = await databaseHarness()
    fakeDocker.shellScripts.set("./reindex", { hang: true })
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })

    const running = harness.commands.run(database, "./reindex")
    for (let step = 0; shellRuns("./reindex").length === 0; step += 1) {
      if (step > 10_000) throw new Error("The command never started")
      await new Promise((resolve) => setImmediate(resolve))
    }
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    await expect(running).resolves.toEqual({
      exitCode: null,
      output: "",
      truncated: false,
      unknown:
        "The command didn't finish within 10 minutes and may still be running",
    })
    expect(shellRuns("./reindex")).toHaveLength(1)
  })

  it("fails without running in a container that has no sh", async () => {
    const harness = await databaseHarness()
    fakeDocker.missingPrograms.add("sh")

    await expect(harness.commands.run(database, "./migrate")).rejects.toThrow(
      "The database's container has no sh to run the command"
    )
  })

  it("fails without running when the container is replaced before Docker starts it", async () => {
    const harness = await databaseHarness()
    const container = databaseContainer()
    const held = fakeDocker.hold({ command: "exec", target: container.name })

    const running = harness.commands.run(database, "./migrate")
    await held.reached
    fakeDocker.removeContainer(container.name)
    held.release()

    await expect(running).rejects.toThrow(
      "The database's container was replaced; the command didn't run"
    )
    expect(container.processes).toEqual([])
  })

  it("fails for an App service that has no container", async () => {
    const harness = await relayHarness()
    const appId = "a".repeat(40)
    await harness.apps.create({ id: appId, name: "Website" })

    await expect(
      harness.commands.run(
        { id: appId, kind: "app", service: "worker" },
        "./migrate"
      )
    ).rejects.toThrow("worker has no container; deploy the App first")
  })
})
