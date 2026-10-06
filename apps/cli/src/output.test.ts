import { Cause } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { z } from "zod"

import { commandError } from "./errors.js"
import { renderErrorCause } from "./output.js"

describe("CLI output", () => {
  it("preserves typed errors that become defects", () => {
    expect(
      renderErrorCause(
        Cause.die(
          commandError({
            code: "invalid_url",
            exitCode: 2,
            message: "Kiln URL must be an absolute HTTP or HTTPS URL.",
          })
        )
      )
    ).toEqual({
      exitCode: 2,
      output: [
        "Error: Kiln URL must be an absolute HTTP or HTTPS URL.",
        "Code: invalid_url",
        "",
      ].join("\n"),
    })
  })

  it("includes concise details for typed failures", () => {
    expect(
      renderErrorCause(
        Cause.fail(
          commandError({
            cause: new Error("connect ECONNREFUSED kiln.example.test:443"),
            code: "network_error",
            exitCode: 5,
            message: "Could not reach https://kiln.example.test.",
            retryable: true,
          })
        )
      )
    ).toEqual({
      exitCode: 5,
      output: [
        "Error: Could not reach https://kiln.example.test.",
        "Code: network_error",
        "Cause: connect ECONNREFUSED kiln.example.test:443",
        "Hint: This operation may succeed if retried.",
        "",
      ].join("\n"),
    })
  })

  it("renders a Relay correlation ID separately from the cause", () => {
    expect(
      renderErrorCause(
        Cause.fail(
          commandError({
            cause: new Error("Survival is not running"),
            code: "relay_operation_failed",
            message: "Relay could not send the console command.",
            requestId: "3df56ba5-b2c1-45ee-bab7-386fbb9223c7",
          })
        )
      )
    ).toEqual({
      exitCode: 1,
      output: [
        "Error: Relay could not send the console command.",
        "Code: relay_operation_failed",
        "Request: 3df56ba5-b2c1-45ee-bab7-386fbb9223c7",
        "Cause: Survival is not running",
        "",
      ].join("\n"),
    })
  })

  it("identifies invalid response fields without dumping the response", () => {
    const decoded = z
      .object({ instance: z.object({ state: z.string() }) })
      .safeParse({ instance: {} })
    expect(decoded.success).toBe(false)
    if (decoded.success) return

    const report = renderErrorCause(
      Cause.fail(
        commandError({
          cause: decoded.error,
          code: "invalid_response",
          message: "Hearth returned a response the CLI does not understand.",
        })
      )
    )

    expect(report).toEqual({
      exitCode: 1,
      output: [
        "Error: Hearth returned a response the CLI does not understand.",
        "Code: invalid_response",
        "Cause: instance.state: Invalid input: expected string, received undefined",
        "",
      ].join("\n"),
    })
  })

  it("reports the message from unexpected defects", () => {
    expect(
      renderErrorCause(Cause.die(new TypeError("Cannot decode power response")))
    ).toEqual({
      exitCode: 1,
      output: [
        "Error: Cannot decode power response",
        "Code: unexpected_error",
        "",
      ].join("\n"),
    })
  })

  it("does not report interruptions as unexpected failures", () => {
    expect(renderErrorCause(Cause.interrupt(1))).toEqual({
      exitCode: 130,
      output: "",
    })
  })
})
