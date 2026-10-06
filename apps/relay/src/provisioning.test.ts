import { describe, expect, it } from "vite-plus/test"

import { provisioningErrorMessage } from "./provisioning-errors.js"

const pullFailure = new Error(
  "Command failed: docker pull private.example/image --env TOKEN=secret\nError response from daemon: manifest unknown\n"
)

describe("provisioning errors", () => {
  it("shows Docker's final detail without exposing the command line", () => {
    const message = provisioningErrorMessage(pullFailure)

    expect(message).toBe("Error response from daemon: manifest unknown")
    expect(message).not.toContain("secret")
  })

  it("looks through Effect's promise wrapper to the Docker failure", () => {
    const wrapped = new Error("An error occurred in Effect.tryPromise", {
      cause: pullFailure,
    })

    expect(provisioningErrorMessage(wrapped)).toBe(
      provisioningErrorMessage(pullFailure)
    )
  })

  it("turns exhausted Docker address pools into guidance instead of raw output", () => {
    const message = provisioningErrorMessage(
      new Error("An error occurred in Effect.tryPromise", {
        cause: new Error(
          "Command failed: docker network create kiln-minecraft\nError response from daemon: all predefined address pools have been fully subnetted\n"
        ),
      })
    )

    expect(message).not.toContain("Command failed")
    expect(message).not.toContain("fully subnetted")
  })

  it("still explains a failure that carries no message", () => {
    expect(provisioningErrorMessage(null)).not.toBe("")
  })
})
