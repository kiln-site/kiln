import {
  brickRecipeSchema,
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
  relayCreateInstanceSchema,
  type RelayInstancePortProtocol,
} from "@workspace/contracts"
import { Effect, Exit } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { relayHarness } from "./test/relay.js"

const first = "a".repeat(40)
const second = "b".repeat(40)

describe("instance port lifecycle", () => {
  it("expires abandoned leases, enforces lease ownership, and lets one concurrent reservation win", async () => {
    vi.useFakeTimers({
      now: Date.parse("2026-07-30T12:00:00.000Z"),
      toFake: ["Date"],
    })
    try {
      const harness = await relayHarness({
        KILN_RELAY_GAME_PORT_RANGE: "32125-32125",
      })
      await harness.seedServer({ id: first })
      await harness.seedServer({ id: second })
      const reserve = (
        instanceId: string,
        leaseId?: string,
        externalPort?: number
      ) =>
        Effect.runPromiseExit(
          harness.lifecycle.reserveInstancePortEffect(instanceId, {
            externalPort,
            leaseId,
            protocol: "tcp",
          })
        )
      const release = (instanceId: string, leaseId: string) =>
        Effect.runPromiseExit(
          harness.lifecycle.releaseInstancePortEffect(instanceId, leaseId)
        )
      const lease = (
        exit: Exit.Exit<{ externalPort: number; id: string }, unknown>
      ) => {
        if (Exit.isFailure(exit)) throw new Error("Expected a port lease")
        return exit.value
      }
      const failureCode = (exit: Exit.Exit<unknown, { code: string }>) =>
        Exit.isFailure(exit)
          ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
              .code
          : undefined

      const abandoned = lease(await reserve(first))
      expect(abandoned.externalPort).toBe(32_125)
      // A failed renewal must not release the port it already holds.
      expect(failureCode(await reserve(first, abandoned.id, 32_126))).toBe(
        "allocation_failed"
      )
      expect(Exit.isFailure(await reserve(second))).toBe(true)

      vi.setSystemTime(Date.parse("2026-07-30T12:02:00.001Z"))
      const reclaimed = lease(await reserve(second))
      expect(reclaimed.externalPort).toBe(32_125)

      expect(Exit.isSuccess(await release(second, reclaimed.id))).toBe(true)
      const released = lease(await reserve(first))
      expect(released.externalPort).toBe(32_125)
      expect(failureCode(await release(second, released.id))).toBe(
        "lease_owner_mismatch"
      )
      expect(Exit.isSuccess(await release(first, released.id))).toBe(true)

      const outcomes = await Promise.all([reserve(first), reserve(second)])
      expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("never gives a stopped game server's port to another adding a protocol", async () => {
    const harness = await relayHarness({
      KILN_RELAY_GAME_PORT_RANGE: "30000-30000",
    })
    const recipe = (protocol: "tcp" | "udp") =>
      brickRecipeSchema.parse({
        format: "kiln.brick/v1",
        metadata: {
          author: "Kiln",
          description: "Test recipe",
          game: "Test",
          id: `game-${protocol}`,
          name: "Game",
        },
        variables: {},
        runtime: {
          environment: {},
          image: `example.test/game-${protocol}:latest`,
          name: "Game",
          resources: { memory: "512M", pids: 128 },
          storage: { mount: "/server" },
        },
        network: {
          mode: "direct",
          ports: [{ container: 7777, name: "game", protocol }],
          primaryPort: "game",
        },
      })
    const create = (id: string, protocol: "tcp" | "udp", start: boolean) =>
      harness.lifecycle.createInstanceWithId(
        id,
        relayCreateInstanceSchema.parse({
          diskLimitBytes: MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
          name: `Game ${protocol}`,
          recipe: `https://bricks.test/game-${protocol}.yml`,
          recipeDefinition: recipe(protocol),
          start,
          variables: {},
        })
      )
    // One running on 30000/tcp, and one stopped on 30000/udp.
    const running = await create(first, "tcp", true)
    const stopped = await create(second, "udp", false)
    expect(running.ports[0]?.externalPort).toBe(30_000)
    expect(stopped.ports[0]?.externalPort).toBe(30_000)

    const widened = (protocol: RelayInstancePortProtocol) =>
      harness.lifecycle.updateInstancePorts(
        first,
        running.ports.map((allocation) => ({
          id: allocation.id,
          internalPort: allocation.internalPort,
          name: allocation.name,
          protocol,
        })),
        []
      )
    await expect(widened("both")).rejects.toThrow(/already in use/u)
  })
})
