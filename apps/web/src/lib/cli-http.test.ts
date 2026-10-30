import { describe, expect, it } from "vite-plus/test"

import { cliFailureResponse } from "@/lib/cli-http"

describe("CLI HTTP failures", () => {
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
