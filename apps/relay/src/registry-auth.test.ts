import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

import { DockerEngine } from "./docker-engine.js"
import { fakeDocker } from "./test/docker.js"

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kiln-docker-config-"))
  vi.stubEnv("DOCKER_CONFIG", directory)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  fakeDocker.reset()
  await rm(directory, { force: true, recursive: true })
})

async function pull(...images: Array<string>) {
  const engine = new DockerEngine(await fakeDocker.listen())
  for (const image of images) await Effect.runPromise(engine.pullImage(image))
}

function login(auths: Record<string, unknown>) {
  return writeFile(join(directory, "config.json"), JSON.stringify({ auths }))
}

const basic = (username: string, password: string) =>
  Buffer.from(`${username}:${password}`).toString("base64")

describe("registry credentials for pulls", () => {
  it("sends each registry only its own credentials", async () => {
    await login({
      "https://index.docker.io/v1/": { auth: basic("hub-user", "hub-secret") },
      "ghcr.io": { auth: basic("gh-user", "gh-secret") },
    })

    await pull("nginx:1.27", "ghcr.io/kiln-site/relay:latest", "quay.io/a/b:1")

    expect(fakeDocker.pulls.get("docker.io/library/nginx:1.27")).toEqual({
      password: "hub-secret",
      serveraddress: "https://index.docker.io/v1/",
      username: "hub-user",
    })
    expect(fakeDocker.pulls.get("ghcr.io/kiln-site/relay:latest")).toEqual({
      password: "gh-secret",
      serveraddress: "ghcr.io",
      username: "gh-user",
    })
    expect(fakeDocker.pulls.get("quay.io/a/b:1")).toBeNull()
  })
})
