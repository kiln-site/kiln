import { afterEach, describe, expect, it } from "vite-plus/test"

import {
  cliDefaultAccessDays,
  emailDeliveryConfig,
  kilnGitRepository,
  kilnInstallationId,
  kilnRootDomain,
} from "./environment"

const originalKilnUrl = process.env.KILN_URL
const originalCliDefaultAccessDays = process.env.KILN_CLI_DEFAULT_ACCESS_DAYS
const originalKilnInstallationId = process.env.KILN_INSTALLATION_ID
const originalKilnGitRepo = process.env.KILN_GIT_REPO
const originalResendApiKey = process.env.RESEND_API_KEY
const originalResendFromEmail = process.env.RESEND_FROM_EMAIL

afterEach(() => {
  if (originalKilnUrl === undefined) delete process.env.KILN_URL
  else process.env.KILN_URL = originalKilnUrl
  if (originalCliDefaultAccessDays === undefined) {
    delete process.env.KILN_CLI_DEFAULT_ACCESS_DAYS
  } else {
    process.env.KILN_CLI_DEFAULT_ACCESS_DAYS = originalCliDefaultAccessDays
  }
  if (originalKilnInstallationId === undefined) {
    delete process.env.KILN_INSTALLATION_ID
  } else {
    process.env.KILN_INSTALLATION_ID = originalKilnInstallationId
  }
  if (originalKilnGitRepo === undefined) delete process.env.KILN_GIT_REPO
  else process.env.KILN_GIT_REPO = originalKilnGitRepo
  if (originalResendApiKey === undefined) delete process.env.RESEND_API_KEY
  else process.env.RESEND_API_KEY = originalResendApiKey
  if (originalResendFromEmail === undefined) {
    delete process.env.RESEND_FROM_EMAIL
  } else {
    process.env.RESEND_FROM_EMAIL = originalResendFromEmail
  }
})

describe("emailDeliveryConfig", () => {
  it("enables delivery only when both Resend settings are configured", () => {
    delete process.env.RESEND_API_KEY
    delete process.env.RESEND_FROM_EMAIL
    expect(emailDeliveryConfig()).toBeNull()

    process.env.RESEND_API_KEY = "resend-key"
    expect(emailDeliveryConfig()).toBeNull()

    process.env.RESEND_FROM_EMAIL = "Kiln <kiln@example.com>"
    expect(emailDeliveryConfig()).toEqual({
      apiKey: "resend-key",
      from: "Kiln <kiln@example.com>",
    })
  })
})

describe("kilnGitRepository", () => {
  it("defaults to the Kiln repository and normalizes overrides", () => {
    delete process.env.KILN_GIT_REPO
    expect(kilnGitRepository()).toBe("https://github.com/kiln-site/kiln")

    process.env.KILN_GIT_REPO = "example/fork.git"
    expect(kilnGitRepository()).toBe("https://github.com/example/fork")
  })

  it("rejects values that cannot back GitHub API and raw content URLs", () => {
    process.env.KILN_GIT_REPO = "https://git.example.com/example/fork"
    expect(() => kilnGitRepository()).toThrow("KILN_GIT_REPO")
  })
})

describe("kilnInstallationId", () => {
  it("uses a stable safe default and validates deployment IDs", () => {
    delete process.env.KILN_INSTALLATION_ID
    expect(kilnInstallationId()).toBe("kiln")
    process.env.KILN_INSTALLATION_ID = "kiln-production_1"
    expect(kilnInstallationId()).toBe("kiln-production_1")
    process.env.KILN_INSTALLATION_ID = "not/a/key-segment"
    expect(() => kilnInstallationId()).toThrow("KILN_INSTALLATION_ID")
  })
})

describe("cliDefaultAccessDays", () => {
  it("defaults full CLI access to 30 days", () => {
    delete process.env.KILN_CLI_DEFAULT_ACCESS_DAYS
    expect(cliDefaultAccessDays()).toBe(30)
  })

  it("accepts a bounded deployment override", () => {
    process.env.KILN_CLI_DEFAULT_ACCESS_DAYS = "14"
    expect(cliDefaultAccessDays()).toBe(14)
  })

  it.each(["0", "366", "1.5", "never"])(
    "rejects invalid values (%s)",
    (value) => {
      process.env.KILN_CLI_DEFAULT_ACCESS_DAYS = value
      expect(() => cliDefaultAccessDays()).toThrow(
        "KILN_CLI_DEFAULT_ACCESS_DAYS"
      )
    }
  )
})

describe("kilnRootDomain", () => {
  it.each([
    ["https://hearth.kiln.site", "kiln.site"],
    ["https://panel.example.co.uk/path", "example.co.uk"],
    ["https://hearth.preview.orb.local", "orb.local"],
    ["http://localhost:3000", "localhost"],
    ["http://127.0.0.1:3000", "127.0.0.1"],
  ])("extracts the base domain from %s", (url, expected) => {
    process.env.KILN_URL = url
    expect(kilnRootDomain()).toBe(expected)
  })
})
