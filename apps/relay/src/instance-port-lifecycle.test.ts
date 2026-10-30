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
})
