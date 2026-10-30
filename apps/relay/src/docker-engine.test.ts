import { Effect, Result } from "effect"
import { describe, expect, it, onTestFinished } from "vite-plus/test"

import { DockerEngine, DockerEngineError } from "./docker-engine.js"
import { fakeDocker } from "./test/docker.js"

async function engineWithContainer() {
  const engine = new DockerEngine(await fakeDocker.listen())
  onTestFinished(() => fakeDocker.reset())
  fakeDocker.addContainer({ name: "kiln-database", running: true })
  return engine
}

// A stream error nobody listens to is an uncaught exception that stops the
// Relay; these fail the run with one if a process's streams raise it.
describe("exec processes", () => {
  it("stops a process whose input is still open without an uncaught error", async () => {
    const engine = await engineWithContainer()
    const process = await Effect.runPromise(
      engine.execProcess("kiln-database", ["psql"], { stdin: true })
    )
    process.stdin.write("SELECT pg_sleep(60);\n")

    expect(process.kill()).toBe(true)

    await expect(Effect.runPromise(process.exitCode)).resolves.toBe(-1)
    expect(process.stdin.destroyed).toBe(true)
  })

  it("fails a process Docker breaks off with an error, with no uncaught error", async () => {
    const engine = await engineWithContainer()
    fakeDocker.streamErrors.set("pg_dump", "container is being removed")
    const process = await Effect.runPromise(
      engine.execProcess("kiln-database", ["pg_dump"])
    )

    const exited = await Effect.runPromise(Effect.result(process.exitCode))

    expect(Result.isFailure(exited) && exited.failure).toBeInstanceOf(
      DockerEngineError
    )
    expect(Result.isFailure(exited) && exited.failure.message).toContain(
      "container is being removed"
    )
  })
})
