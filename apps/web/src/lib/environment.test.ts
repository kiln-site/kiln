import { afterEach, describe, expect, it } from "vite-plus/test"

import {
  cliDefaultAccessDays,
  kilnGitRepository,
  kilnInstallationId,
} from "./environment"

const originalCliDefaultAccessDays = process.env.KILN_CLI_DEFAULT_ACCESS_DAYS
const originalKilnInstallationId = process.env.KILN_INSTALLATION_ID
const originalKilnGitRepo = process.env.KILN_GIT_REPO

afterEach(() => {
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
})

describe("kilnGitRepository", () => {
  it("rejects values that cannot back GitHub API and raw content URLs", () => {
    process.env.KILN_GIT_REPO = "https://git.example.com/example/fork"
    expect(() => kilnGitRepository()).toThrow("KILN_GIT_REPO")
  })
})

describe("kilnInstallationId", () => {
  it("rejects deployment IDs that are not safe key segments", () => {
    process.env.KILN_INSTALLATION_ID = "not/a/key-segment"
    expect(() => kilnInstallationId()).toThrow("KILN_INSTALLATION_ID")
  })
})

describe("cliDefaultAccessDays", () => {
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
