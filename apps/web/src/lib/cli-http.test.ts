import { describe, expect, it } from "vite-plus/test"

import { CliAccessError } from "@/effect/errors"
import { cliFailureResponse } from "@/lib/cli-http"

describe("CLI HTTP failures", () => {
  it("returns a structured Relay failure with its correlation ID", async () => {
    const requestId = "3df56ba5-b2c1-45ee-bab7-386fbb9223c7"
    const response = cliFailureResponse(
      CliAccessError.make({
        code: "relay_operation_failed",
        detail: "Survival is not running",
        message: "Relay could not send the console command.",
        requestId,
        retryable: false,
      })
    )

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      error: {
        cause: "Survival is not running",
        code: "relay_operation_failed",
        message: "Relay could not send the console command.",
        requestId,
        retryable: false,
      },
    })
  })

  it("keeps an unrelated Hearth application failure generic", async () => {
    const response = cliFailureResponse(new Error("database password leaked"))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unexpected_error",
        message: "Hearth could not complete the CLI request.",
        retryable: false,
      },
    })
  })
})
