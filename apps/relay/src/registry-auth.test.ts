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

    expect(fakeDocker.pullCredentials.get("docker.io/library/nginx:1.27")).toEqual({
      password: "hub-secret",
      serveraddress: "https://index.docker.io/v1/",
      username: "hub-user",
    })
    expect(
      fakeDocker.pullCredentials.get("ghcr.io/kiln-site/relay:latest")
    ).toEqual({
      password: "gh-secret",
      serveraddress: "ghcr.io",
      username: "gh-user",
    })
    expect(fakeDocker.pullCredentials.get("quay.io/a/b:1")).toBeNull()
  })

  it("finds credentials saved with a scheme or path, and identity tokens", async () => {
    await login({
      "https://registry.example.com/v2/": { identitytoken: "refresh-token" },
    })

    await pull("registry.example.com/team/app@sha256:" + "a".repeat(64))

    expect(
      fakeDocker.pullCredentials.get(
        `registry.example.com/team/app@sha256:${"a".repeat(64)}`
      )
    ).toEqual({
      identitytoken: "refresh-token",
      serveraddress: "registry.example.com",
    })
  })

  it("prefers DOCKER_AUTH_CONFIG's credentials to the config file's, by registry", async () => {
    await login({
      "https://index.docker.io/v1/": { auth: basic("hub-user", "hub-secret") },
      "ghcr.io": { auth: basic("file-user", "file-secret") },
    })
    vi.stubEnv(
      "DOCKER_AUTH_CONFIG",
      JSON.stringify({
        auths: { "ghcr.io": { auth: basic("env-user", "env-secret") } },
      })
    )

    await pull("ghcr.io/kiln-site/relay:latest", "nginx:1.27", "quay.io/a/b:1")

    expect(
      fakeDocker.pullCredentials.get("ghcr.io/kiln-site/relay:latest")
    ).toEqual({
      password: "env-secret",
      serveraddress: "ghcr.io",
      username: "env-user",
    })
    expect(fakeDocker.pullCredentials.get("docker.io/library/nginx:1.27")).toEqual({
      password: "hub-secret",
      serveraddress: "https://index.docker.io/v1/",
      username: "hub-user",
    })
    expect(fakeDocker.pullCredentials.get("quay.io/a/b:1")).toBeNull()
  })

  it("forwards a registry token saved without a username", async () => {
    await login({ "ghcr.io": { registrytoken: "bearer-token" } })

    await pull("ghcr.io/kiln-site/relay:latest")

    expect(
      fakeDocker.pullCredentials.get("ghcr.io/kiln-site/relay:latest")
    ).toEqual({ registrytoken: "bearer-token", serveraddress: "ghcr.io" })
  })

  it("pulls anonymously without a config, and with one it can't read", async () => {
    await pull("alpine:3.21")
    await writeFile(join(directory, "config.json"), "{ not json")
    await pull("busybox:1")

    expect(fakeDocker.pullCredentials.get("docker.io/library/alpine:3.21")).toBeNull()
    expect(fakeDocker.pullCredentials.get("docker.io/library/busybox:1")).toBeNull()
  })
})
