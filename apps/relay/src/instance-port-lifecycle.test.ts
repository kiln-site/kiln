import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { it as effectIt } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import {
  relayInstanceSchema,
  type RelayInstance,
  type RelayInstancePortAllocation,
} from "@workspace/contracts"

const commandMock = vi.hoisted(() => vi.fn())

vi.mock("./command.js", () => ({ command: commandMock }))

import type { BrickCatalog } from "./bricks.js"
import { loadConfig } from "./config.js"
import type { DockerDriver } from "./docker.js"
import { LifecycleDriver } from "./lifecycle.js"

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  vi.useRealTimers()
  commandMock.mockReset()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

describe("instance port lifecycle", () => {
  it("bootstraps a missing primary allocation from a primary port input", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "kiln-primary-port-"))
    temporaryDirectories.push(dataDirectory)
    const config = loadConfig({
      KILN_RELAY_DATA_DIR: dataDirectory,
      KILN_RELAY_GAME_PORT_RANGE: "32123-32123",
      KILN_RELAY_PROXY: "hearth",
      KILN_RELAY_RESOURCE_NAMESPACE: "primary-port-test",
      NODE_ENV: "test",
    })
    const instance = relayInstanceSchema.parse({
      brickNetworkMode: "direct",
      connectAddress: "legacy.test",
      containerId: "legacy-container",
      desiredState: "stopped",
      directory: "a".repeat(40),
      game: "Minecraft",
      id: "a".repeat(40),
      implementation: "Paper",
      javaVersion: "21",
      managedByRelay: true,
      name: "Legacy server",
      observedState: "stopped",
      publicHost: "legacy.test",
      service: "kiln-legacy",
      shortId: "aaaaaaaa",
      startedAt: null,
      status: "created",
      version: "1.21.11",
    })
    const primary = {
      externalPort: 32_123,
      id: "primary",
      internalPort: 25_570,
      kind: "primary",
      name: "Default Server",
      protocol: "tcp",
    } satisfies RelayInstancePortAllocation
    const recreateOwnedInstance = vi.fn(
      async (): Promise<RelayInstance> => ({
        ...instance,
        connectAddress: "legacy.test:32123",
        ports: [primary],
        publicPort: 32_123,
      })
    )
    const docker = {
      inspectInstances: vi.fn(async () => [instance]),
      publishedHostPorts: vi.fn(async () => []),
      recreateOwnedInstance,
    } as unknown as DockerDriver
    commandMock.mockRejectedValue(new Error("container not found"))
    const lifecycle = new LifecycleDriver(config, docker, {} as BrickCatalog)

    const updated = await lifecycle.updateInstancePorts(
      instance.id,
      [
        {
          id: "primary",
          internalPort: 25_570,
          name: "Ignored client name",
          protocol: "tcp",
        },
      ],
      []
    )

    expect(updated.ports).toEqual([primary])
    expect(recreateOwnedInstance).toHaveBeenCalledWith(
      instance,
      {
        "kiln.relay.web-routes.revision":
          "809b57ac6cc136a5e7bb9babc8418a73d2cfafcb6cfb1e1697214c164a001631",
        "traefik.enable": "false",
      },
      null,
      "stop",
      {
        bindings: {
          "25570/tcp": [{ HostIp: "", HostPort: "32123" }],
        },
        labels: {
          "kiln.brick.primary-port": "25570/tcp",
          "kiln.traefik.service.port": "25570",
        },
      }
    )
  })

  it("updates an existing allocation protocol when the added binding is available", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "kiln-port-protocol-"))
    temporaryDirectories.push(dataDirectory)
    const config = loadConfig({
      KILN_RELAY_DATA_DIR: dataDirectory,
      KILN_RELAY_GAME_PORT_RANGE: "32123-32123",
      KILN_RELAY_PROXY: "hearth",
      KILN_RELAY_RESOURCE_NAMESPACE: "port-protocol-test",
      NODE_ENV: "test",
    })
    const primary = {
      externalPort: 32_123,
      id: "primary",
      internalPort: 25_565,
      kind: "primary",
      name: "Default Server",
      protocol: "tcp",
    } satisfies RelayInstancePortAllocation
    const instance = relayInstanceSchema.parse({
      brickNetworkMode: "direct",
      connectAddress: "protocol.test:32123",
      containerId: "protocol-container",
      desiredState: "stopped",
      directory: "e".repeat(40),
      game: "Minecraft",
      id: "e".repeat(40),
      implementation: "Paper",
      javaVersion: "21",
      managedByRelay: true,
      name: "Protocol server",
      observedState: "stopped",
      ports: [primary],
      publicHost: "protocol.test",
      publicPort: 32_123,
      service: "kiln-protocol",
      shortId: "eeeeeeee",
      startedAt: null,
      status: "created",
      version: "1.21.11",
    })
    const updatedPrimary = {
      ...primary,
      protocol: "both",
    } satisfies RelayInstancePortAllocation
    const recreateOwnedInstance = vi.fn(
      async (): Promise<RelayInstance> => ({
        ...instance,
        ports: [updatedPrimary],
      })
    )
    const publishedHostPorts = vi.fn(async () => new Set<number>())
    const docker = {
      inspectInstances: vi.fn(async () => [instance]),
      publishedHostPorts,
      recreateOwnedInstance,
    } as unknown as DockerDriver
    commandMock.mockRejectedValue(new Error("container not found"))
    const lifecycle = new LifecycleDriver(config, docker, {} as BrickCatalog)

    const updated = await lifecycle.updateInstancePorts(
      instance.id,
      [
        {
          id: "primary",
          internalPort: 25_565,
          name: "Default Server",
          protocol: "both",
        },
      ],
      []
    )

    expect(updated.ports).toEqual([updatedPrimary])
    expect(publishedHostPorts).toHaveBeenCalledWith("udp", {
      end: 32_123,
      start: 32_123,
    })
    expect(recreateOwnedInstance).toHaveBeenCalledWith(
      instance,
      expect.any(Object),
      null,
      "stop",
      {
        bindings: {
          "25565/tcp": [{ HostIp: "", HostPort: "32123" }],
          "25565/udp": [{ HostIp: "", HostPort: "32123" }],
        },
        labels: {
          "kiln.brick.primary-port": "25565",
          "kiln.traefik.service.port": "25565",
        },
      }
    )
  })

  it("updates the public port of an existing primary allocation from a lease", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "kiln-primary-public-port-")
    )
    temporaryDirectories.push(dataDirectory)
    const config = loadConfig({
      KILN_RELAY_DATA_DIR: dataDirectory,
      KILN_RELAY_GAME_PORT_RANGE: "32124-32124",
      KILN_RELAY_PROXY: "hearth",
      KILN_RELAY_RESOURCE_NAMESPACE: "primary-public-port-test",
      NODE_ENV: "test",
    })
    const primary = {
      externalPort: 32_123,
      id: "primary",
      internalPort: 25_565,
      kind: "primary",
      name: "Default Server",
      protocol: "tcp",
    } satisfies RelayInstancePortAllocation
    const instance = relayInstanceSchema.parse({
      brickNetworkMode: "direct",
      connectAddress: "public-port.test:32123",
      containerId: "public-port-container",
      desiredState: "stopped",
      directory: "f".repeat(40),
      game: "Minecraft",
      id: "f".repeat(40),
      implementation: "Paper",
      javaVersion: "21",
      managedByRelay: true,
      name: "Public port server",
      observedState: "stopped",
      ports: [primary],
      publicHost: "public-port.test",
      publicPort: 32_123,
      service: "kiln-public-port",
      shortId: "ffffffff",
      startedAt: null,
      status: "created",
      version: "1.21.11",
    })
    const updatedPrimary = { ...primary, externalPort: 32_124 }
    const recreateOwnedInstance = vi.fn(
      async (): Promise<RelayInstance> => ({
        ...instance,
        connectAddress: "public-port.test:32124",
        ports: [updatedPrimary],
        publicPort: 32_124,
      })
    )
    const docker = {
      inspectInstances: vi.fn(async () => [instance]),
      publishedHostPorts: vi.fn(async () => new Set<number>()),
      recreateOwnedInstance,
    } as unknown as DockerDriver
    commandMock.mockRejectedValue(new Error("container not found"))
    const lifecycle = new LifecycleDriver(config, docker, {} as BrickCatalog)
    const lease = await Effect.runPromise(
      lifecycle.reserveInstancePortEffect(instance.id, {
        externalPort: 32_124,
        protocol: "tcp",
      })
    )
    expect(lease.externalPort).toBe(32_124)

    const updated = await lifecycle.updateInstancePorts(
      instance.id,
      [
        {
          externalPort: lease.externalPort,
          id: "primary",
          internalPort: 25_565,
          leaseId: lease.id,
          name: "Default Server",
          protocol: "tcp",
        },
      ],
      []
    )

    expect(updated.ports).toEqual([updatedPrimary])
    expect(recreateOwnedInstance).toHaveBeenCalledWith(
      instance,
      expect.any(Object),
      null,
      "stop",
      {
        bindings: {
          "25565/tcp": [{ HostIp: "", HostPort: "32124" }],
        },
        labels: {
          "kiln.brick.primary-port": "25565/tcp",
          "kiln.traefik.service.port": "25565",
        },
      }
    )
  })

  effectIt.effect(
    "allows an explicit public port outside the configured range only with an override",
    () =>
      Effect.gen(function* () {
        const dataDirectory = yield* Effect.tryPromise(() =>
          mkdtemp(join(tmpdir(), "kiln-public-port-range-override-"))
        )
        temporaryDirectories.push(dataDirectory)
        const config = loadConfig({
          KILN_RELAY_DATA_DIR: dataDirectory,
          KILN_RELAY_GAME_PORT_RANGE: "32124-32124",
          KILN_RELAY_PROXY: "hearth",
          KILN_RELAY_RESOURCE_NAMESPACE: "public-port-range-override-test",
          NODE_ENV: "test",
        })
        const instance = relayInstanceSchema.parse({
          brickNetworkMode: "direct",
          connectAddress: "port-range-override.test:32123",
          containerId: "port-range-override-container",
          desiredState: "stopped",
          directory: "e".repeat(40),
          game: "Minecraft",
          id: "e".repeat(40),
          implementation: "Paper",
          javaVersion: "21",
          managedByRelay: true,
          name: "Port range override server",
          observedState: "stopped",
          publicHost: "port-range-override.test",
          publicPort: 32_123,
          service: "kiln-port-range-override",
          shortId: "eeeeeeee",
          startedAt: null,
          status: "created",
          version: "1.21.11",
        })
        const docker = {
          inspectInstances: vi.fn(async () => [instance]),
          publishedHostPorts: vi.fn(async () => new Set<number>()),
        } as unknown as DockerDriver
        const lifecycle = new LifecycleDriver(
          config,
          docker,
          {} as BrickCatalog
        )

        const denied = yield* lifecycle
          .reserveInstancePortEffect(instance.id, {
            externalPort: 8_211,
            protocol: "tcp",
          })
          .pipe(Effect.flip)
        expect(denied.message).toContain(
          "Public port must be between 32124 and 32124"
        )

        const lease = yield* lifecycle.reserveInstancePortEffect(instance.id, {
          externalPort: 8_211,
          overridePortRange: true,
          protocol: "tcp",
        })
        expect(lease.externalPort).toBe(8_211)
      })
  )

  it("reserves added protocols on a replacement public port", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "kiln-primary-port-protocol-")
    )
    temporaryDirectories.push(dataDirectory)
    const config = loadConfig({
      KILN_RELAY_DATA_DIR: dataDirectory,
      KILN_RELAY_GAME_PORT_RANGE: "32124-32124",
      KILN_RELAY_PROXY: "hearth",
      KILN_RELAY_RESOURCE_NAMESPACE: "primary-port-protocol-test",
      NODE_ENV: "test",
    })
    const primary = {
      externalPort: 32_123,
      id: "primary",
      internalPort: 25_565,
      kind: "primary",
      name: "Default Server",
      protocol: "tcp",
    } satisfies RelayInstancePortAllocation
    const instance = relayInstanceSchema.parse({
      brickNetworkMode: "direct",
      connectAddress: "port-protocol.test:32123",
      containerId: "port-protocol-container",
      desiredState: "stopped",
      directory: "1".repeat(40),
      game: "Minecraft",
      id: "1".repeat(40),
      implementation: "Paper",
      javaVersion: "21",
      managedByRelay: true,
      name: "Port and protocol server",
      observedState: "stopped",
      ports: [primary],
      publicHost: "port-protocol.test",
      publicPort: 32_123,
      service: "kiln-port-protocol",
      shortId: "11111111",
      startedAt: null,
      status: "created",
      version: "1.21.11",
    })
    const updatedPrimary = {
      ...primary,
      externalPort: 32_124,
      protocol: "both",
    } satisfies RelayInstancePortAllocation
    const recreateOwnedInstance = vi.fn(
      async (): Promise<RelayInstance> => ({
        ...instance,
        connectAddress: "port-protocol.test:32124",
        ports: [updatedPrimary],
        publicPort: 32_124,
      })
    )
    const publishedHostPorts = vi.fn(async (protocol: "tcp" | "udp") =>
      protocol === "udp" ? new Set([32_123]) : new Set<number>()
    )
    const docker = {
      inspectInstances: vi.fn(async () => [instance]),
      publishedHostPorts,
      recreateOwnedInstance,
    } as unknown as DockerDriver
    commandMock.mockRejectedValue(new Error("container not found"))
    const lifecycle = new LifecycleDriver(config, docker, {} as BrickCatalog)
    const lease = await Effect.runPromise(
      lifecycle.reserveInstancePortEffect(instance.id, {
        externalPort: 32_124,
        protocol: "both",
      })
    )

    const updated = await lifecycle.updateInstancePorts(
      instance.id,
      [
        {
          externalPort: lease.externalPort,
          id: "primary",
          internalPort: 25_565,
          leaseId: lease.id,
          name: "Default Server",
          protocol: "both",
        },
      ],
      []
    )

    expect(updated.ports).toEqual([updatedPrimary])
    expect(publishedHostPorts).toHaveBeenCalledTimes(2)
    expect(publishedHostPorts).toHaveBeenNthCalledWith(1, "tcp", {
      end: 32_124,
      start: 32_124,
    })
    expect(publishedHostPorts).toHaveBeenNthCalledWith(2, "udp", {
      end: 32_124,
      start: 32_124,
    })
    expect(recreateOwnedInstance).toHaveBeenCalledWith(
      instance,
      expect.any(Object),
      null,
      "stop",
      {
        bindings: {
          "25565/tcp": [{ HostIp: "", HostPort: "32124" }],
          "25565/udp": [{ HostIp: "", HostPort: "32124" }],
        },
        labels: {
          "kiln.brick.primary-port": "25565",
          "kiln.traefik.service.port": "25565",
        },
      }
    )
  })

  effectIt.effect(
    "reclaims abandoned port leases and releases closed ones",
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"))
        const dataDirectory = yield* Effect.tryPromise(() =>
          mkdtemp(join(tmpdir(), "kiln-port-lease-"))
        )
        temporaryDirectories.push(dataDirectory)
        const config = loadConfig({
          KILN_RELAY_DATA_DIR: dataDirectory,
          KILN_RELAY_GAME_PORT_RANGE: "32125-32125",
          KILN_RELAY_PROXY: "hearth",
          KILN_RELAY_RESOURCE_NAMESPACE: "port-lease-test",
          NODE_ENV: "test",
        })
        const first = relayInstanceSchema.parse({
          brickNetworkMode: "direct",
          connectAddress: "first.test",
          containerId: "first-container",
          desiredState: "stopped",
          directory: "c".repeat(40),
          game: "Minecraft",
          id: "c".repeat(40),
          implementation: "Paper",
          javaVersion: "21",
          managedByRelay: true,
          name: "First server",
          observedState: "stopped",
          publicHost: "first.test",
          service: "kiln-first",
          shortId: "cccccccc",
          startedAt: null,
          status: "created",
          version: "1.21.11",
        })
        const second = relayInstanceSchema.parse({
          ...first,
          connectAddress: "second.test",
          containerId: "second-container",
          directory: "d".repeat(40),
          id: "d".repeat(40),
          name: "Second server",
          publicHost: "second.test",
          service: "kiln-second",
          shortId: "dddddddd",
        })
        const docker = {
          inspectInstances: vi.fn(async () => [first, second]),
          publishedHostPorts: vi.fn(async () => []),
        } as unknown as DockerDriver
        const lifecycle = new LifecycleDriver(
          config,
          docker,
          {} as BrickCatalog
        )

        const abandoned = yield* lifecycle.reserveInstancePortEffect(first.id, {
          protocol: "tcp",
        })
        expect(abandoned.externalPort).toBe(32_125)
        const renewalFailure = yield* lifecycle
          .reserveInstancePortEffect(first.id, {
            externalPort: 32_126,
            leaseId: abandoned.id,
            protocol: "tcp",
          })
          .pipe(Effect.flip)
        expect(renewalFailure.code).toBe("allocation_failed")
        const unavailable = yield* lifecycle
          .reserveInstancePortEffect(second.id, { protocol: "tcp" })
          .pipe(Effect.flip)
        expect(unavailable.message).toContain("No game ports are available")

        yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(120_001))
        const reclaimed = yield* lifecycle.reserveInstancePortEffect(
          second.id,
          { protocol: "tcp" }
        )
        expect(reclaimed.externalPort).toBe(32_125)

        yield* lifecycle.releaseInstancePortEffect(second.id, reclaimed.id)
        const released = yield* lifecycle.reserveInstancePortEffect(first.id, {
          protocol: "tcp",
        })
        expect(released.externalPort).toBe(32_125)

        const ownershipFailure = yield* lifecycle
          .releaseInstancePortEffect(second.id, released.id)
          .pipe(Effect.flip)
        expect(ownershipFailure.code).toBe("lease_owner_mismatch")
        yield* lifecycle.releaseInstancePortEffect(first.id, released.id)

        vi.useRealTimers()
        const [failures, concurrent] = yield* Effect.partition(
          [first.id, second.id],
          (instanceId) =>
            lifecycle.reserveInstancePortEffect(instanceId, {
              protocol: "tcp",
            }),
          { concurrency: "unbounded" }
        )
        expect(failures).toHaveLength(1)
        expect(concurrent).toHaveLength(1)
        expect(concurrent[0]?.externalPort).toBe(32_125)
      })
  )

  it("stages a missing primary port without requiring a free public port", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "kiln-primary-port-"))
    temporaryDirectories.push(dataDirectory)
    const config = loadConfig({
      KILN_RELAY_DATA_DIR: dataDirectory,
      KILN_RELAY_GAME_PORT_RANGE: "32124-32124",
      KILN_RELAY_PROXY: "hearth",
      KILN_RELAY_RESOURCE_NAMESPACE: "pending-primary-port-test",
      NODE_ENV: "test",
    })
    const instance = relayInstanceSchema.parse({
      brickNetworkMode: "direct",
      connectAddress: "legacy.test",
      containerId: "legacy-container",
      desiredState: "running",
      directory: "b".repeat(40),
      game: "Minecraft",
      id: "b".repeat(40),
      implementation: "Paper",
      javaVersion: "21",
      managedByRelay: true,
      name: "Running legacy server",
      observedState: "running",
      publicHost: "legacy.test",
      service: "kiln-running-legacy",
      shortId: "bbbbbbbb",
      startedAt: new Date().toISOString(),
      status: "running",
      version: "1.21.11",
    })
    await mkdir(join(config.rootDirectory, instance.directory), {
      recursive: true,
    })
    const primary = {
      externalPort: 32_124,
      id: "primary",
      internalPort: 24_454,
      kind: "primary",
      name: "Default Server",
      protocol: "tcp",
    } satisfies RelayInstancePortAllocation
    const recreateOwnedInstance = vi.fn(
      async (): Promise<RelayInstance> => ({
        ...instance,
        connectAddress: "legacy.test:32124",
        ports: [primary],
        publicPort: 32_124,
      })
    )
    const publishedHostPorts = vi.fn(async () => new Set([32_124]))
    const docker = {
      inspectInstances: vi.fn(async () => [instance]),
      publishedHostPorts,
      recreateOwnedInstance,
      runAction: vi.fn(),
    } as unknown as DockerDriver
    commandMock.mockRejectedValue(new Error("container not found"))
    const lifecycle = new LifecycleDriver(config, docker, {} as BrickCatalog)

    const staged = await lifecycle.updateInstancePorts(
      instance.id,
      [
        {
          id: "primary",
          internalPort: 24_454,
          name: "Ignored client name",
          protocol: "tcp",
        },
      ],
      []
    )

    expect(staged.pendingPrimaryPort).toEqual({
      id: "primary",
      internalPort: 24_454,
      name: "Default Server",
      protocol: "tcp",
    })
    expect(staged.ports).toEqual([])
    expect(recreateOwnedInstance).not.toHaveBeenCalled()
    expect(publishedHostPorts).not.toHaveBeenCalled()

    publishedHostPorts.mockResolvedValue(new Set())
    const updated = await lifecycle.runInstanceAction(
      instance,
      "restart",
      [],
      staged.pendingPrimaryPort
    )

    expect(updated.ports).toEqual([primary])
    expect(recreateOwnedInstance).toHaveBeenCalledWith(
      instance,
      {
        "kiln.relay.web-routes.revision":
          "809b57ac6cc136a5e7bb9babc8418a73d2cfafcb6cfb1e1697214c164a001631",
        "traefik.enable": "false",
      },
      null,
      "restart",
      {
        bindings: {
          "24454/tcp": [{ HostIp: "", HostPort: "32124" }],
        },
        labels: {
          "kiln.brick.primary-port": "24454/tcp",
          "kiln.traefik.service.port": "24454",
        },
      }
    )
  })
})
