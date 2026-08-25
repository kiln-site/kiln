import { describe, expect, it } from "vite-plus/test"

import {
  cliCreateServerRequestSchema,
  MAXIMUM_INSTANCE_NAME_LENGTH,
} from "@workspace/contracts"
import { CliAccessError } from "@/effect/errors"
import { cliFailureResponse, cliInvalidRequest } from "@/lib/cli-http"

describe("CLI HTTP failures", () => {
  it("returns field-specific validation details for oversized server names", async () => {
    const parsed = cliCreateServerRequestSchema.safeParse({
      brick: "paper",
      diskLimitBytes: 1024 ** 3,
      name: "a".repeat(MAXIMUM_INSTANCE_NAME_LENGTH + 1),
      relayId: "r".repeat(43),
      start: true,
      variables: {},
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return

    const response = cliFailureResponse(cliInvalidRequest(parsed.error))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        cause: "name: Names must be 32 characters or fewer",
        code: "invalid_request",
        message: "The CLI request contains invalid input.",
        retryable: false,
      },
    })
  })

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
