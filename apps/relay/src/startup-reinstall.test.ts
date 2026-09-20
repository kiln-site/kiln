import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import {
  brickRecipeSchema,
  relayInstanceSchema,
  relayUpdateInstanceStartupSchema,
  type BrickRecipe,
  type RelayInstance,
  type RelayInstancePortAllocation,
} from "@workspace/contracts"

const commandMock = vi.hoisted(() => vi.fn())

vi.mock("./command.js", () => ({ command: commandMock }))

import type { BrickCatalog } from "./bricks.js"
import { loadConfig } from "./config.js"
import type { DockerDriver } from "./docker.js"
import {
  databaseConnectionLabels,
  type DatabaseConnections,
} from "./database-connections.js"
import {
  LifecycleDriver,
  resolveInstanceStartupReconfigure,
} from "./lifecycle.js"

const recipeSource = "https://example.com/example.yml"
const recipe: BrickRecipe = brickRecipeSchema.parse({
  format: "kiln.brick/v1",
  metadata: {
    id: "example",
    name: "Example",
    description: "A test Brick recipe.",
    game: "Example Game",
    author: "Kiln",
  },
  variables: {
    version: {
      type: "string",
      label: "Version",
      description: "Release to install.",
      required: true,
      default: "1.2.3",
      rules: { pattern: "^[0-9.]+$" },
    },
    memory: {
      type: "string",
      label: "Memory",
      description: "Memory allocation.",
      required: true,
      default: "2G",
      options: ["2G", "4G"],
    },
    java_version: {
      type: "string",
      label: "Java version",
      description: "JDK release used to run the server.",
      required: true,
      default: "21",
      options: ["21", "25"],
    },
  },
  runtime: {
    image: "registry.example.com/custom/server:{{ variables.java_version }}",
    name: "Java {{ variables.java_version }}",
    environment: {
      VERSION: "{{ variables.version }}",
    },
    resources: {
      memory: "{{ variables.memory }}",
      memoryReservation: "{{ variables.memory }}",
      pids: 128,
    },
    storage: { mount: "/server" },
  },
  network: {
    mode: "direct",
    primaryPort: "game",
    hostname: "{{ brick.id }}",
    ports: [{ name: "game", container: 7777, protocol: "udp" }],
  },
})

const primaryPort = {
  externalPort: 32_123,
  id: "primary",
  internalPort: 7777,
  kind: "primary",
  name: "Game",
  protocol: "udp",
} satisfies RelayInstancePortAllocation

const appliedVariables = {
  java_version: "21",
  memory: "2G",
  version: "1.2.3",
}

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  commandMock.mockReset()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

function instance(overrides: Partial<RelayInstance> = {}): RelayInstance {
  return relayInstanceSchema.parse({
    brickNetworkMode: "direct",
    brickSource: recipeSource,
    connectAddress: "example.test:32123",
    containerId: "example-container",
    desiredState: "running",
    directory: "a".repeat(40),
    game: "Example Game",
    id: "a".repeat(40),
    implementation: "Example",
    javaVersion: "21",
    limits: {
      diskBytes: 25 * 1024 ** 3,
      memoryBytes: 2 * 1024 ** 3,
    },
    managedByRelay: true,
    name: "Example server",
    observedState: "running",
    ports: [primaryPort],
    publicHost: "example.test",
    publicPort: 32_123,
    service: "kiln-example",
    shortId: "aaaaaaaa",
    startedAt: null,
    status: "running",
    variables: appliedVariables,
    version: "1.2.3",
    ...overrides,
  })
}

describe("startup reinstall resolution", () => {
  const snapshotSha256 = "b".repeat(64)

  it("ignores stale client Brick, variables, limits, and start on reinstall", () => {
    const resolved = resolveInstanceStartupReconfigure(
      instance({
        brickSnapshotSha256: snapshotSha256,
        observedState: "running",
      }),
      relayUpdateInstanceStartupSchema.parse({
        diskLimitBytes: 40 * 1024 ** 3,
        recipe: "https://example.com/other.yml",
        reinstall: true,
        start: false,
        variables: {
          java_version: "25",
          memory: "4G",
          version: "9.9.9",
        },
      })
    )

    expect(resolved).toEqual({
      diskLimitBytes: 25 * 1024 ** 3,
      forcePull: true,
      recipe: recipeSource,
      snapshotSha256,
      start: true,
      tailscale: { enabled: false },
      variables: appliedVariables,
    })
  })

  it("starts after reinstall when the desired state is running", () => {
    const resolved = resolveInstanceStartupReconfigure(
      instance({ desiredState: "running", observedState: "failed" }),
      relayUpdateInstanceStartupSchema.parse({
        reinstall: true,
        start: false,
      })
    )

    expect(resolved.start).toBe(true)
  })

  it("keeps a stopped server stopped even when the client asks to start", () => {
    const resolved = resolveInstanceStartupReconfigure(
      instance({ desiredState: "stopped", observedState: "stopped" }),
      relayUpdateInstanceStartupSchema.parse({
        reinstall: true,
        start: true,
      })
    )

    expect(resolved.start).toBe(false)
    expect(resolved.forcePull).toBe(true)
  })

  it("still applies client startup patches when reinstall is omitted", () => {
    const resolved = resolveInstanceStartupReconfigure(
      instance({ observedState: "stopped" }),
      relayUpdateInstanceStartupSchema.parse({
        recipe: "https://example.com/other.yml",
        start: true,
        variables: {
          java_version: "25",
          memory: "4G",
          version: "1.2.3",
        },
      })
    )

    expect(resolved).toMatchObject({
      forcePull: false,
      recipe: "https://example.com/other.yml",
      start: true,
      variables: {
        java_version: "25",
        memory: "4G",
        version: "1.2.3",
      },
    })
    expect(resolved.snapshotSha256).toBeUndefined()
  })

  it("reuses the stored snapshot when the submitted source is unchanged", () => {
    const resolved = resolveInstanceStartupReconfigure(
      instance({ brickSnapshotSha256: snapshotSha256 }),
      relayUpdateInstanceStartupSchema.parse({
        recipe: recipeSource,
        start: true,
        variables: appliedVariables,
      })
    )

    expect(resolved.snapshotSha256).toBe(snapshotSha256)
  })
})

describe("startup reinstall pull ordering", () => {
  it("pulls the Ember image before deleting the existing container", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "kiln-reinstall-pull-"))
    temporaryDirectories.push(dataDirectory)
    const existing = instance()
    await mkdir(join(dataDirectory, "instances", existing.directory), {
      recursive: true,
    })
    const calls: Array<string> = []
    commandMock.mockImplementation(
      async (_executable: string, args: Array<string>) => {
        calls.push(args[0] ?? "")
        if (args[0] === "pull") {
          throw new Error("registry timeout")
        }
        return { stderr: "", stdout: "" }
      }
    )
    const docker = {
      inspectInstances: vi.fn(async () => [existing]),
    } as unknown as DockerDriver
    const lifecycle = new LifecycleDriver(
      loadConfig({
        KILN_RELAY_DATA_DIR: dataDirectory,
        KILN_RELAY_GAME_PORT_RANGE: "32123-32123",
        KILN_RELAY_PROXY: "hearth",
        KILN_RELAY_RESOURCE_NAMESPACE: "reinstall-pull-test",
        NODE_ENV: "test",
      }),
      docker,
      { recipe: async () => recipe } as unknown as BrickCatalog
    )

    await expect(
      lifecycle.reconfigureInstance(
        existing.id,
        relayUpdateInstanceStartupSchema.parse({ reinstall: true })
      )
    ).rejects.toThrow("registry timeout")

    expect(calls[0]).toBe("pull")
    expect(calls).not.toContain("stop")
    expect(calls).not.toContain("rm")
  })
})

describe("startup database connections", () => {
  it.each([false, true])(
    "restores connections before starting a replacement (reinstall=%s)",
    async (reinstall) => {
      const dataDirectory = await mkdtemp(
        join(tmpdir(), "kiln-startup-databases-")
      )
      temporaryDirectories.push(dataDirectory)
      const existing = instance()
      await mkdir(join(dataDirectory, "instances", existing.directory), {
        recursive: true,
      })
      const calls: Array<Array<string>> = []
      commandMock.mockImplementation(
        async (_executable: string, args: Array<string>) => {
          calls.push(args)
          if (args[0] === "network" && args[1] === "inspect")
            return {
              stderr: "",
              stdout: JSON.stringify({
                "kiln.relay.network": "game",
                "kiln.relay.owner": "database-test",
              }),
            }
          return { stderr: "", stdout: "[]" }
        }
      )
      const labels = databaseConnectionLabels([
        { databaseId: "b".repeat(40), relayId: "r".repeat(43) },
      ])
      const connections = {
        labels: vi.fn(async () => labels),
        reconcile: vi.fn(async () => {
          calls.push(["restore-databases"])
        }),
      } as unknown as DatabaseConnections
      const docker = {
        inspectInstances: vi.fn(async () => [existing]),
        recordProvisionedState: vi.fn(async () => undefined),
      } as unknown as DockerDriver
      const lifecycle = new LifecycleDriver(
        loadConfig({
          KILN_RELAY_DATA_DIR: dataDirectory,
          KILN_RELAY_GAME_PORT_RANGE: "32123-32123",
          KILN_RELAY_PROXY: "hearth",
          KILN_RELAY_RESOURCE_NAMESPACE: "database-test",
          NODE_ENV: "test",
        }),
        docker,
        {
          recipe: async () => recipe,
          saveSnapshot: async () => "b".repeat(64),
        } as unknown as BrickCatalog,
        connections
      )
      await lifecycle.reconfigureInstance(
        existing.id,
        relayUpdateInstanceStartupSchema.parse(
          reinstall
            ? { reinstall: true }
            : { start: true, variables: appliedVariables }
        )
      )
      const create = calls.find(
        (args) => args[0] === "container" && args[1] === "create"
      )!
      for (const [key, value] of Object.entries(labels))
        expect(create).toContain(`${key}=${value}`)
      expect(connections.labels).toHaveBeenCalledWith(existing.id)
      expect(connections.reconcile).toHaveBeenCalledWith(
        existing.id,
        "database-test-kiln-aaaaaaaa"
      )
      const restoreIndex = calls.findIndex(
        (args) => args[0] === "restore-databases"
      )
      expect(restoreIndex).toBeGreaterThan(calls.indexOf(create))
      expect(restoreIndex).toBeLessThan(
        calls.findIndex((args) => args[0] === "start")
      )
    }
  )
})
