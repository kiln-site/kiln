import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import {
  builtinTailscaleBrickId,
  relayTailscaleStackApplySchema,
  relayTailscaleStackConfigSchema,
  relayTailscaleStackSchema,
} from "@workspace/contracts"

const commandMock = vi.hoisted(() => vi.fn())

vi.mock("./command.js", () => ({ command: commandMock }))

import { BrickCatalog } from "./bricks.js"
import { loadConfig, type RelayInstanceConfig } from "./config.js"
import { DockerDriver } from "./docker.js"
import { LifecycleDriver } from "./lifecycle.js"

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  commandMock.mockReset()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

describe("Tailscale pending removal recovery", () => {
  it("commits cleanup when the prepared Tailscale container is already stopped", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "kiln-tailscale-prepared-")
    )
    temporaryDirectories.push(dataDirectory)
    const config = loadConfig({
      KILN_RELAY_DATA_DIR: dataDirectory,
      KILN_RELAY_RESOURCE_NAMESPACE: "prepared-removal-test",
      NODE_ENV: "test",
    })
    const id = "f".repeat(40)
    const stackDirectory = join(config.rootDirectory, id)
    const stackConfig = relayTailscaleStackConfigSchema.parse({
      bindings: [],
      domain: "test",
      hostname: "private-network",
      id,
      name: "Private Network",
      subnet: "10.165.54.0/24",
    })
    await mkdir(stackDirectory, { recursive: true })
    await Promise.all([
      writeFile(
        join(stackDirectory, "stack.json"),
        `${JSON.stringify(stackConfig)}\n`
      ),
      writeFile(join(stackDirectory, ".removing"), "prepared\n"),
    ])

    const container = "prepared-removal-test-kiln-ts-ffffffff"
    let containerPresent = true
    commandMock.mockImplementation(
      async (_executable: string, arguments_: Array<string>) => {
        const name = arguments_.at(-1)
        if (arguments_[0] === "container" && arguments_[1] === "inspect") {
          if (name !== container || !containerPresent) {
            throw new Error("container not found")
          }
          if (arguments_[3] === "{{.State.Running}}") {
            return { stderr: "", stdout: "false\n" }
          }
          if (arguments_[3] === "{{.Id}}") {
            return { stderr: "", stdout: "container-id\n" }
          }
          return {
            stderr: "",
            stdout: JSON.stringify({
              "kiln.relay.owner": "prepared-removal-test",
            }),
          }
        }
        if (arguments_[0] === "stop") {
          throw new Error(`container ${container} is not running`)
        }
        if (arguments_[0] === "rm") containerPresent = false
        if (arguments_[0] === "network" && arguments_[1] === "inspect") {
          return {
            stderr: "",
            stdout: JSON.stringify({
              "kiln.relay.owner": "prepared-removal-test",
            }),
          }
        }
        return { stderr: "", stdout: "" }
      }
    )

    const lifecycle = new LifecycleDriver(
      config,
      new DockerDriver(config),
      new BrickCatalog(config.brickCatalogUrl, config.dataDirectory)
    )

    await lifecycle.removeTailscaleStack(id)

    expect(commandMock).not.toHaveBeenCalledWith(
      "docker",
      ["stop", "--time", "10", container],
      expect.anything()
    )
    expect(commandMock).toHaveBeenCalledWith("docker", ["start", container], {
      timeout: 30_000,
    })
    await expect(access(stackDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("rejects revival while a failed removal remains retryable", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "kiln-tailscale-removal-")
    )
    temporaryDirectories.push(dataDirectory)
    const config = loadConfig({
      KILN_RELAY_DATA_DIR: dataDirectory,
      KILN_RELAY_RESOURCE_NAMESPACE: "pending-removal-test",
      NODE_ENV: "test",
    })
    const id = "a".repeat(40)
    const stackDirectory = join(config.rootDirectory, id)
    const stackConfig = relayTailscaleStackConfigSchema.parse({
      bindings: [],
      domain: "test",
      hostname: "private-network",
      id,
      name: "Private Network",
      subnet: "10.165.55.0/24",
    })
    const snapshot = relayTailscaleStackSchema.parse({
      ...stackConfig,
      components: {
        coreDnsRunning: false,
        tailscaleRunning: false,
      },
      instance: {
        brickId: builtinTailscaleBrickId,
        connectAddress: "private-network.test",
        containerId: "docker-container-id",
        desiredState: "stopped",
        directory: id,
        game: "Networking",
        id,
        implementation: "Tailscale",
        javaVersion: "Tailscale + CoreDNS",
        managedByRelay: true,
        name: "Private Network",
        observedState: "stopped",
        service: "pending-removal-test-kiln-ts-aaaaaaaa",
        shortId: id.slice(0, 8),
        startedAt: null,
        status: "Exited (0)",
        version: "stable",
      },
      status: {
        connected: false,
        ipv4Address: null,
        ipv6Address: null,
        message: "Tailscale is stopped",
      },
    })
    await mkdir(stackDirectory, { recursive: true })
    await Promise.all([
      writeFile(
        join(stackDirectory, "stack.json"),
        `${JSON.stringify(stackConfig)}\n`
      ),
      writeFile(join(stackDirectory, ".removing"), "prepared\n"),
      writeFile(
        join(stackDirectory, ".removing-stack.json"),
        `${JSON.stringify(snapshot)}\n`
      ),
    ])

    let networkRemoveAttempts = 0
    commandMock.mockImplementation(
      async (_executable: string, arguments_: Array<string>) => {
        if (arguments_[0] === "container" && arguments_[1] === "inspect") {
          throw new Error("container not found")
        }
        if (arguments_[0] === "network" && arguments_[1] === "inspect") {
          return {
            stderr: "",
            stdout: JSON.stringify({
              "kiln.relay.owner": "pending-removal-test",
            }),
          }
        }
        if (arguments_[0] === "network" && arguments_[1] === "rm") {
          networkRemoveAttempts += 1
          if (networkRemoveAttempts === 1) {
            throw new Error("bridge is still in use")
          }
        }
        return { stderr: "", stdout: "" }
      }
    )

    const lifecycle = new LifecycleDriver(
      config,
      new DockerDriver(config),
      new BrickCatalog(config.brickCatalogUrl, config.dataDirectory)
    )

    await expect(lifecycle.removeTailscaleStack(id)).rejects.toThrow(
      "bridge is still in use"
    )
    const commandCallsAfterCleanupFailure = commandMock.mock.calls.length
    expect((await lifecycle.tailscaleStacks())[0]?.status.message).toBe(
      "Removal pending"
    )

    const apply = relayTailscaleStackApplySchema.parse({
      bindings: [],
      domain: "test",
      hostname: "private-network",
      id,
      name: "Private Network",
    })
    await expect(lifecycle.applyTailscaleStack(apply)).rejects.toThrow(
      "removal cleanup is pending"
    )

    const instance: RelayInstanceConfig = {
      brickId: builtinTailscaleBrickId,
      connectAddress: "private-network.test",
      directory: id,
      game: "Networking",
      id,
      implementation: "Tailscale",
      javaVersion: "Tailscale + CoreDNS",
      limits: {
        diskBytes: 128 * 1024 * 1024,
        memoryBytes: 64 * 1024 * 1024,
      },
      managedByRelay: true,
      name: "Private Network",
      ports: [],
      service: "pending-removal-test-kiln-ts-aaaaaaaa",
      shortId: id.slice(0, 8),
      tailscale: { enabled: false },
      version: "stable",
    }
    await expect(
      lifecycle.runInstanceAction(instance, "start", [])
    ).rejects.toThrow("removal cleanup is pending")
    await expect(
      lifecycle.runInstanceAction(instance, "restart", [])
    ).rejects.toThrow("removal cleanup is pending")
    expect(commandMock).toHaveBeenCalledTimes(commandCallsAfterCleanupFailure)

    await lifecycle.removeTailscaleStack(id)

    expect(networkRemoveAttempts).toBe(2)
    await expect(access(stackDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("preserves authenticated state when logout fails and retries cleanup", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "kiln-tailscale-logout-")
    )
    temporaryDirectories.push(dataDirectory)
    const config = loadConfig({
      KILN_RELAY_DATA_DIR: dataDirectory,
      KILN_RELAY_RESOURCE_NAMESPACE: "logout-test",
      NODE_ENV: "test",
    })
    const id = "b".repeat(40)
    const stackDirectory = join(config.rootDirectory, id)
    const stackConfig = relayTailscaleStackConfigSchema.parse({
      bindings: [],
      domain: "test",
      hostname: "private-network",
      id,
      name: "Private Network",
      subnet: "10.165.56.0/24",
    })
    await mkdir(stackDirectory, { recursive: true })
    await Promise.all([
      writeFile(
        join(stackDirectory, "stack.json"),
        `${JSON.stringify(stackConfig)}\n`
      ),
      writeFile(join(stackDirectory, ".removing"), "prepared\n"),
    ])

    const container = "logout-test-kiln-ts-bbbbbbbb"
    let logoutAttempts = 0
    let containerPresent = true
    commandMock.mockImplementation(
      async (_executable: string, arguments_: Array<string>) => {
        const name = arguments_.at(-1)
        if (arguments_[0] === "container" && arguments_[1] === "inspect") {
          if (name !== container || !containerPresent) {
            throw new Error("container not found")
          }
          return {
            stderr: "",
            stdout:
              arguments_[3] === "{{.Id}}"
                ? "container-id\n"
                : JSON.stringify({ "kiln.relay.owner": "logout-test" }),
          }
        }
        if (
          arguments_[0] === "exec" &&
          arguments_.includes("logout") &&
          logoutAttempts++ < 3
        ) {
          throw new Error("control plane unavailable")
        }
        if (arguments_[0] === "network" && arguments_[1] === "inspect") {
          return {
            stderr: "",
            stdout: JSON.stringify({
              "kiln.relay.owner": "logout-test",
              "kiln.relay.network": `tailscale:${id}`,
            }),
          }
        }
        if (arguments_[0] === "run") containerPresent = true
        return { stderr: "", stdout: "" }
      }
    )
    const lifecycle = new LifecycleDriver(
      config,
      new DockerDriver(config),
      new BrickCatalog(config.brickCatalogUrl, config.dataDirectory)
    )

    await expect(lifecycle.removeTailscaleStack(id)).rejects.toThrow(
      "local identity was preserved for retry"
    )
    await expect(access(join(stackDirectory, ".removing"))).resolves.toBe(
      undefined
    )
    containerPresent = false
    const stateDirectory = join(
      config.dataDirectory,
      "infrastructure",
      "tailscale-stacks",
      id,
      "state"
    )
    await mkdir(stateDirectory, { recursive: true })
    await writeFile(join(stateDirectory, "tailscaled.state"), "{}\n")

    await lifecycle.removeTailscaleStack(id)

    expect(logoutAttempts).toBe(4)
    expect(
      commandMock.mock.calls.some(
        ([, arguments_]) =>
          arguments_[0] === "run" && arguments_.includes(container)
      )
    ).toBe(true)
    await expect(access(stackDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("restores forwarding rules for a running stack and then stays idle", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "kiln-tailscale-firewall-")
    )
    temporaryDirectories.push(dataDirectory)
    const config = loadConfig({
      KILN_RELAY_DATA_DIR: dataDirectory,
      KILN_RELAY_RESOURCE_NAMESPACE: "firewall-test",
      NODE_ENV: "test",
    })
    const id = "c".repeat(40)
    const stackDirectory = join(config.rootDirectory, id)
    const stackConfig = relayTailscaleStackConfigSchema.parse({
      bindings: [
        {
          address: "10.165.57.10",
          hostname: "paper",
          instanceId: "d".repeat(40),
        },
      ],
      domain: "test",
      hostname: "private-network",
      id,
      name: "Private Network",
      subnet: "10.165.57.0/24",
    })
    await mkdir(stackDirectory, { recursive: true })
    await writeFile(
      join(stackDirectory, "stack.json"),
      `${JSON.stringify(stackConfig)}\n`
    )
    let current = false
    commandMock.mockImplementation(
      async (_executable: string, arguments_: Array<string>) => {
        if (
          arguments_[0] === "container" &&
          arguments_[1] === "inspect" &&
          arguments_[3] === "{{.Id}}|{{.State.StartedAt}}|{{.State.Running}}"
        ) {
          return {
            stderr: "",
            stdout: "container-id|2026-07-28T18:00:00Z|true\n",
          }
        }
        if (arguments_[0] === "exec" && arguments_.includes("-C")) {
          if (!current) throw new Error("rule missing")
          return { stderr: "", stdout: "" }
        }
        if (arguments_[0] === "exec" && arguments_.includes("-S")) {
          if (!current) throw new Error("chain missing")
          return {
            stderr: "",
            stdout: [
              "-N KILN-TAILSCALE",
              "-A KILN-TAILSCALE -d 10.165.57.10/32 -j RETURN",
              "-A KILN-TAILSCALE -j DROP",
            ].join("\n"),
          }
        }
        return { stderr: "", stdout: "" }
      }
    )
    const lifecycle = new LifecycleDriver(
      config,
      new DockerDriver(config),
      new BrickCatalog(config.brickCatalogUrl, config.dataDirectory)
    )

    await lifecycle.reconcileTailscaleStackFirewalls()
    const mutationsAfterRepair = commandMock.mock.calls.filter(
      ([, arguments_]) =>
        arguments_[0] === "exec" &&
        (arguments_.includes("-I") ||
          arguments_.includes("-F") ||
          arguments_.includes("-A"))
    ).length
    current = true
    await lifecycle.reconcileTailscaleStackFirewalls()

    expect(mutationsAfterRepair).toBeGreaterThan(0)
    expect(
      commandMock.mock.calls.filter(
        ([, arguments_]) =>
          arguments_[0] === "exec" &&
          (arguments_.includes("-I") ||
            arguments_.includes("-F") ||
            arguments_.includes("-A"))
      )
    ).toHaveLength(mutationsAfterRepair)
  })
})
