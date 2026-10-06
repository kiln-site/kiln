import { Cause, Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { z } from "zod"

import { commandError, type CliCommandError } from "./errors.js"
import { reportErrorCauseEffect } from "./output.js"

const originalExitCode = process.exitCode

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = originalExitCode
})

// What a user or script sees: stderr and the process exit code.
async function report(cause: Cause.Cause<CliCommandError>) {
  let stderr = ""
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
  await Effect.runPromise(reportErrorCauseEffect(cause))
  const exitCode = process.exitCode
  vi.restoreAllMocks()
  return { exitCode, stderr }
}

describe("CLI error reporting", () => {
  it("keeps the exit code and error code of typed errors that become defects", async () => {
    const { exitCode, stderr } = await report(
      Cause.die(
        commandError({
          code: "invalid_url",
          exitCode: 2,
          message: "Kiln URL must be an absolute HTTP or HTTPS URL.",
        })
      )
    )

    expect(exitCode).toBe(2)
    expect(stderr).toContain("invalid_url")
    expect(stderr).toContain("Kiln URL must be an absolute HTTP or HTTPS URL.")
  })

  it("includes the underlying cause and Relay correlation ID", async () => {
    const requestId = "3df56ba5-b2c1-45ee-bab7-386fbb9223c7"
    const { exitCode, stderr } = await report(
      Cause.fail(
        commandError({
          cause: new Error("connect ECONNREFUSED kiln.example.test:443"),
          code: "network_error",
          exitCode: 5,
          message: "Could not reach https://kiln.example.test.",
          requestId,
          retryable: true,
        })
      )
    )

    expect(exitCode).toBe(5)
    expect(stderr).toContain("network_error")
    expect(stderr).toContain("ECONNREFUSED kiln.example.test:443")
    expect(stderr).toContain(requestId)
  })

  it("names the invalid response field", async () => {
    const decoded = z
      .object({ instance: z.object({ state: z.string() }) })
      .safeParse({ instance: {} })
    if (decoded.success) throw new Error("Expected an invalid response")

    const { exitCode, stderr } = await report(
      Cause.fail(
        commandError({
          cause: decoded.error,
          code: "invalid_response",
          message: "Hearth returned a response the CLI does not understand.",
        })
      )
    )

    expect(exitCode).toBe(1)
    expect(stderr).toContain("invalid_response")
    expect(stderr).toContain("instance.state")
  })

  it("reports unexpected defects with their message", async () => {
    const { exitCode, stderr } = await report(
      Cause.die(new TypeError("Cannot decode power response"))
    )

    expect(exitCode).toBe(1)
    expect(stderr).toContain("unexpected_error")
    expect(stderr).toContain("Cannot decode power response")
  })

  it("exits 130 without reporting an error for interruptions", async () => {
    expect(await report(Cause.interrupt(1))).toEqual({
      exitCode: 130,
      stderr: "",
    })
  })
})
