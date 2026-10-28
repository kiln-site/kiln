import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { assert, layer } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Schedule, Scope } from "effect"
import { TestClock } from "effect/testing"
import { afterAll } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"

import { OperationsEngine } from "./engine"
import { Move, moveHandler } from "./test/move-workflow"

afterAll(() => disposeAppRuntime())

const webRoot = fileURLToPath(new URL("../../", import.meta.url))

/**
 * Runs a Hearth in another process that starts a move and stalls in its
 * copy step, then kills it there. Returns the move's execution ID and the
 * steps it ran.
 */
const startMoveAndKillDuringCopy = (moveId: string) =>
  Effect.callback<{ executionId: string; steps: Array<string> }, Error>(
    (resume) => {
      // One process, so killing it kills the engine, as a crash would.
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/operations/test/move-runner.ts"],
        {
          cwd: webRoot,
          env: { ...process.env, MOVE_ID: moveId },
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        }
      )
      const steps: Array<string> = []
      let executionId: string | null = null
      child.on(
        "message",
        (message: { executionId?: string; step?: string }) => {
          if (message.executionId) executionId = message.executionId
          if (!message.step) return
          steps.push(message.step)
          if (message.step === "copy") child.kill("SIGKILL")
        }
      )
      child.on("exit", () => {
        resume(
          executionId && steps.includes("copy")
            ? Effect.succeed({ executionId, steps })
            : Effect.fail(new Error(`The move stopped early: ${steps}`))
        )
      })
      return Effect.sync(() => child.kill("SIGKILL"))
    }
  )

describeMysql("operations engine", () => {
  layer(TestDatabase, { timeout: 120_000 })((it) => {
    it.effect(
      "finishes a move whose Hearth died mid-step, without running its finished steps again",
      () =>
        // A real process and the engine's own timers run in real time.
        Effect.gen(function* () {
          yield* resetDatabase
          const killed = yield* startMoveAndKillDuringCopy("move-1")

          // A new Hearth picks the move up where the old one died.
          const runs = new Map<string, number>()
          const scope = yield* Scope.make()
          const engine = yield* Layer.buildWithScope(
            moveHandler({
              copied: Effect.void,
              step: (name) =>
                Effect.sync(() => {
                  runs.set(name, (runs.get(name) ?? 0) + 1)
                  return runs.get(name) ?? 0
                }),
            }).pipe(Layer.provideMerge(OperationsEngine)),
            scope
          )
          const result = yield* Move.poll(killed.executionId).pipe(
            Effect.provide(engine),
            Effect.repeat({
              schedule: Schedule.spaced("100 millis"),
              until: (polled) =>
                Option.isSome(polled) && polled.value._tag === "Complete",
            })
          )
          yield* Scope.close(scope, Exit.void)

          assert.deepStrictEqual(killed.steps, ["prepare", "copy"])
          assert.deepStrictEqual(Object.fromEntries(runs), {
            copy: 1,
            handOver: 1,
          })
          assert(Option.isSome(result) && result.value._tag === "Complete")
          assert.deepStrictEqual(result.value.exit, Exit.succeed("1-1-1"))
        }).pipe(TestClock.withLive),
      // The dead Hearth's shard locks expire first.
      120_000
    )
  })
})
