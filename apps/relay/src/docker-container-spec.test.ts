import { Effect, Result } from "effect"
import { describe, expect, it, onTestFinished } from "vite-plus/test"

import { createContainer } from "./docker-container-spec.js"
import { DockerEngine, DockerEngineError } from "./docker-engine.js"
import { fakeDocker } from "./test/docker.js"

async function engine() {
  const engine = new DockerEngine(await fakeDocker.listen())
  onTestFinished(() => fakeDocker.reset())
  return engine
}

describe("container creation", () => {
  it("creates a game server's container as its spec describes", async () => {
    const docker = await engine()
    fakeDocker.addNetwork({ name: "kiln-game" })
    fakeDocker.images.set("alpine:3.21", {})

    await Effect.runPromise(
      createContainer(docker, {
        binds: ["/srv/kiln:/server"],
        command: ["-c", "sleep 1"],
        entrypoint: "/bin/sh",
        env: { A: "1", B: "two words" },
        image: "alpine:3.21",
        interactive: true,
        labels: { "kiln.json": '{"a":[1]}' },
        memory: "1.5g",
        name: "kiln-server",
        network: { aliases: ["kiln-server"], name: "kiln-game" },
        ports: [{ containerPort: 25565, hostPort: 30001, protocol: "tcp" }],
        restart: "no",
        tty: true,
      })
    )

    const container = fakeDocker.container("kiln-server")
    expect(container).toMatchObject({
      cmd: ["-c", "sleep 1"],
      env: { A: "1", B: "two words" },
      labels: { "kiln.json": '{"a":[1]}' },
      memoryBytes: 1.5 * 1024 ** 3,
      openStdin: true,
      portBindings: { "25565/tcp": [{ HostIp: "", HostPort: "30001" }] },
      restartPolicy: "no",
      tty: true,
    })
    expect(container?.networks.get("kiln-game")?.aliases).toContain(
      "kiln-server"
    )
    expect(container?.mounts).toContainEqual(
      expect.objectContaining({ destination: "/server", source: "/srv/kiln" })
    )
  })

  it("reads a size without a unit as bytes", async () => {
    const docker = await engine()
    fakeDocker.images.set("alpine:3.21", {})

    await Effect.runPromise(
      createContainer(docker, {
        image: "alpine:3.21",
        memory: String(512 * 1024 ** 2),
        name: "kiln-sized",
        nanoCpus: 5e8,
      })
    )

    expect(fakeDocker.container("kiln-sized")).toMatchObject({
      memoryBytes: 512 * 1024 ** 2,
      nanoCpus: 5e8,
    })
  })

  it("pulls an image Docker doesn't have before creating", async () => {
    const docker = await engine()

    await Effect.runPromise(
      createContainer(docker, { image: "busybox:1", name: "kiln-pulled" })
    )

    expect(fakeDocker.container("kiln-pulled")?.image).toBe("busybox:1")
  })

  it("fails a create with an invalid size as a Docker error, creating nothing", async () => {
    const docker = await engine()

    const outcome = await Effect.runPromise(
      Effect.result(
        createContainer(docker, {
          image: "alpine:3.21",
          memory: "lots",
          name: "kiln-invalid",
        })
      )
    )

    expect(Result.isFailure(outcome) && outcome.failure).toBeInstanceOf(
      DockerEngineError
    )
    expect(fakeDocker.container("kiln-invalid")).toBeUndefined()
  })
})
