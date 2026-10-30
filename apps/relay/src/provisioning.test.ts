import { describe, expect, it } from "vite-plus/test"

import { provisioningErrorMessage } from "./provisioning-errors.js"

describe("provisioning errors", () => {
  it("shows Docker's final detail without exposing the command line", () => {
    const message = provisioningErrorMessage(
      new Error(
        "Command failed: docker pull private.example/image --env TOKEN=secret\nError response from daemon: manifest unknown\n"
      )
    )

    expect(message).toBe("Error response from daemon: manifest unknown")
    expect(message).not.toContain("secret")
  })
})
