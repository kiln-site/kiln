import { describe, expect, it } from "vite-plus/test"

import { provisioningErrorMessage } from "./provisioning.js"

describe("provisioning errors", () => {
  it("unwraps Effect promise failures and explains exhausted Docker networks", () => {
    const commandError = new Error(
      "Command failed: docker network create kiln-minecraft\nError response from daemon: all predefined address pools have been fully subnetted\n"
    )
    const wrapped = new Error("An error occurred in Effect.tryPromise", {
      cause: commandError,
    })

    expect(provisioningErrorMessage(wrapped)).toBe(
      "Docker could not create Kiln's private server network because all default address pools are in use. Remove unused Docker networks or expand Docker's default-address-pools, then provision the server again."
    )
  })

  it("uses the final command detail without exposing the command", () => {
    expect(
      provisioningErrorMessage(
        new Error(
          "Command failed: docker pull private.example/image\nError response from daemon: manifest unknown\n"
        )
      )
    ).toBe("Error response from daemon: manifest unknown")
  })

  it("falls back to a useful provisioning message", () => {
    expect(provisioningErrorMessage(null)).toBe(
      "The Relay could not finish provisioning this server."
    )
  })
})
