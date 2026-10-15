import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Fiber } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test"

import { loadComposeProject } from "./compose-project.js"
import { composeUp } from "./compose-up.js"
import { DockerEngine } from "./docker-engine.js"
import { fakeDocker } from "./test/docker.js"

const projectName = "kiln-test-compose-up"
const yaml = [
  "services:",
  "  web:",
  "    image: nginx:alpine",
  "    depends_on: [db]",
  "  db:",
  "    image: postgres:17",
].join("\n")

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kiln-compose-up-"))
  fakeDocker.images.set("nginx:alpine", {})
  fakeDocker.images.set("postgres:17", {})
})

afterEach(async () => {
  fakeDocker.reset()
  await rm(directory, { force: true, recursive: true })
})

async function up() {
  const project = await loadComposeProject({
    environment: {},
    onWarning: () => {},
    projectDirectory: directory,
    projectName,
    yaml,
  })
  const engine = new DockerEngine(await fakeDocker.listen())
  return composeUp(engine, {
    onLine: () => {},
    project,
    workingDirectory: directory,
  })
}

// The project's containers, by name, with whether each runs.
const containers = () =>
  [...fakeDocker.containers.values()]
    .map((container) => ({
      id: container.id,
      name: container.name,
      running: container.state.running,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

describe("composeUp redeploys", () => {
  it("replaces each service's container under its name", async () => {
    await Effect.runPromise(await up())
    const before = containers()

    await Effect.runPromise(await up())

    const after = containers()
    expect(after.map(({ name, running }) => ({ name, running }))).toEqual([
      { name: `${projectName}-db-1`, running: true },
      { name: `${projectName}-web-1`, running: true },
    ])
    expect(after.map(({ id }) => id)).not.toContain(before[0]!.id)
    expect(after.map(({ id }) => id)).not.toContain(before[1]!.id)
  })

  it("puts the previous container back when renaming it aside fails after Docker applied it", async () => {
    await Effect.runPromise(await up())
    const before = containers()
    fakeDocker.failAfterNext({ command: "rename" }, "rename timed out")

    const exit = await Effect.runPromiseExit(await up())

    expect(exit._tag).toBe("Failure")
    expect(containers()).toEqual(before)
  })

  it("puts the previous containers back when the deployment is interrupted", async () => {
    await Effect.runPromise(await up())
    const before = containers()
    // The database's replacement has its name, and is starting.
    const starting = fakeDocker.hold({ command: "start" })

    const fiber = Effect.runFork(await up())
    await starting.reached
    expect(fakeDocker.container(before[0]!.id)).toMatchObject({
      name: expect.stringMatching(/_previous$/u),
      state: { running: false },
    })
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    starting.release()
    await interrupted

    expect(containers()).toEqual(before)
  })
})
