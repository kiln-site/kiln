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
// A database with an anonymous volume, and a service that depends on it.
const yaml = (options: { suffix?: string; extra?: string } = {}) =>
  [
    "services:",
    "  web:",
    "    image: nginx:alpine",
    "    depends_on: [db]",
    ...(options.suffix ? [`    container_name: web-${options.suffix}`] : []),
    ...(options.extra ? [options.extra] : []),
    "  db:",
    "    image: postgres:17",
    "    volumes: ['/data']",
    ...(options.suffix ? [`    container_name: db-${options.suffix}`] : []),
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

async function up(
  file: string,
  environment: Readonly<Record<string, string>> = {}
) {
  const project = await loadComposeProject({
    environment,
    onWarning: () => {},
    projectDirectory: directory,
    projectName,
    yaml: file,
  })
  const engine = new DockerEngine(await fakeDocker.listen())
  return composeUp(engine, {
    onLine: () => {},
    project,
    workingDirectory: directory,
  })
}

// The project's containers: each one's name (a temporary one's ID prefix
// as `<id>`), state, and anonymous volume.
const containers = () =>
  [...fakeDocker.containers.values()]
    .map((container) => ({
      data: container.mounts.find((mount) => mount.destination === "/data")
        ?.source,
      name: container.name.replace(/^[0-9a-f]{12}_/u, "<id>_"),
      state: container.state.running
        ? "running"
        : container.starts === 0
          ? "created"
          : "exited",
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

describe("composeUp redeploys, as Compose's reconciler", () => {
  it("replaces each service's container under its name, keeping its anonymous volumes", async () => {
    await Effect.runPromise(await up(yaml()))
    const before = [...fakeDocker.containers.keys()]
    const data = containers()[0]!.data

    await Effect.runPromise(await up(yaml()))

    expect(containers()).toEqual([
      { data, name: `${projectName}-db-1`, state: "running" },
      { data: undefined, name: `${projectName}-web-1`, state: "running" },
    ])
    expect([...fakeDocker.containers.keys()]).not.toContain(before[0])
    expect([...fakeDocker.containers.keys()]).not.toContain(before[1])
  })

  // The end states below are what docker compose v5.5.1 left on Docker for
  // the same failures.
  it("stops where a lost rename answer stops it, and the next deploy finishes", async () => {
    await Effect.runPromise(await up(yaml()))
    const data = containers()[0]!.data
    fakeDocker.failAfterNext({ command: "rename" }, "rename timed out")

    const exit = await Effect.runPromiseExit(await up(yaml()))

    expect(exit._tag).toBe("Failure")
    // The database was replaced and renamed, but not started; the web
    // service's container is the previous one.
    expect(containers()).toEqual([
      { data, name: `${projectName}-db-1`, state: "created" },
      { data: undefined, name: `${projectName}-web-1`, state: "running" },
    ])

    await Effect.runPromise(await up(yaml()))
    expect(containers()).toEqual([
      { data, name: `${projectName}-db-1`, state: "running" },
      { data: undefined, name: `${projectName}-web-1`, state: "running" },
    ])
  })

  it("stops where a lost stop answer stops it, and the next deploy removes what it left", async () => {
    await Effect.runPromise(await up(yaml()))
    const data = containers()[0]!.data
    fakeDocker.failAfterNext({ command: "stop" }, "stop timed out")

    const exit = await Effect.runPromiseExit(await up(yaml()))

    expect(exit._tag).toBe("Failure")
    expect(containers()).toEqual([
      { data, name: `<id>_${projectName}-db-1`, state: "created" },
      { data, name: `${projectName}-db-1`, state: "exited" },
      { data: undefined, name: `${projectName}-web-1`, state: "running" },
    ])

    await Effect.runPromise(await up(yaml()))
    expect(containers()).toEqual([
      { data, name: `${projectName}-db-1`, state: "running" },
      { data: undefined, name: `${projectName}-web-1`, state: "running" },
    ])
  })

  it("leaves an interrupted deploy in a state the next one, under new names, recovers from", async () => {
    await Effect.runPromise(await up(yaml({ suffix: "first" })))
    const data = containers()[0]!.data
    // The previous database is stopping when the deploy is interrupted.
    const stopping = fakeDocker.hold({ command: "stop" })

    const fiber = Effect.runFork(await up(yaml({ suffix: "second" })))
    await stopping.reached
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    stopping.release()
    await interrupted
    expect(containers().map(({ name }) => name)).toEqual([
      "<id>_db-second",
      "db-first",
      "web-first",
    ])

    await Effect.runPromise(await up(yaml({ suffix: "third" })))

    expect(containers()).toEqual([
      { data, name: "db-third", state: "running" },
      { data: undefined, name: "web-third", state: "running" },
    ])
  })

  it("checks a local image against DOCKER_DEFAULT_PLATFORM, and pulls for it", async () => {
    // Present, but for another platform.
    fakeDocker.imagePlatforms.set("postgres:17", "linux/amd64")

    await Effect.runPromise(
      await up(yaml(), { DOCKER_DEFAULT_PLATFORM: "linux/arm64" })
    )

    expect(fakeDocker.pullPlatforms.get("docker.io/library/postgres:17")).toBe(
      "linux/arm64"
    )
  })

  it("publishes a port listed 65,000 times once, without slowing down", async () => {
    const ports = Array.from({ length: 65_000 }, () => "'80'").join(", ")

    const started = performance.now()
    await Effect.runPromise(await up(yaml({ extra: `    ports: [${ports}]` })))

    expect(performance.now() - started).toBeLessThan(2_000)
    const web = [...fakeDocker.containers.values()].find(
      (container) => container.name === `${projectName}-web-1`
    )
    expect(web?.portBindings).toEqual({
      "80/tcp": [{ HostIp: "", HostPort: "" }],
    })
  })
})
