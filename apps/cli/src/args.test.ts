import { describe, expect, it } from "vite-plus/test"

import { parseArguments } from "./args.js"

describe("CLI arguments", () => {
  it("supports command flags in any position", () => {
    expect(
      parseArguments([
        "--profile=automation",
        "server",
        "logs",
        "relay:instance",
        "--follow",
        "--limit",
        "500",
      ])
    ).toMatchObject({
      command: ["server", "logs", "relay:instance"],
      follow: true,
      limit: 500,
      profile: "automation",
    })
  })

  it("rejects unknown options and unsafe limits", () => {
    expect(() => parseArguments(["--unknown"])).toThrow("Unknown option")
    expect(() => parseArguments(["--limit", "10001"])).toThrow(
      "--limit must be"
    )
  })

  it("parses server creation and startup options", () => {
    expect(
      parseArguments([
        "servers",
        "create",
        "relay-id",
        "paper",
        "--name",
        "Survival",
        "--disk=25GiB",
        "--memory",
        "4GiB",
        "--java-version=21",
        "--game-version",
        "1.21.11",
        "--variable",
        "online_mode=json:false",
        "--no-start",
      ])
    ).toMatchObject({
      command: ["servers", "create", "relay-id", "paper"],
      disk: "25GiB",
      gameVersion: "1.21.11",
      javaVersion: "21",
      memory: "4GiB",
      name: "Survival",
      start: false,
      variables: ["online_mode=json:false"],
    })
  })

  it("parses backup destination and restore safety options", () => {
    expect(
      parseArguments([
        "backups",
        "create",
        "server",
        "relay:instance",
        "--storage",
        "local",
        "--mode",
        "full",
        "--no-safety-backup",
      ])
    ).toMatchObject({
      command: ["backups", "create", "server", "relay:instance"],
      mode: "full",
      safetyBackup: false,
      storage: "local",
    })
    expect(() =>
      parseArguments(["backups", "create", "server", "relay:instance", "--mode", "zip"])
    ).toThrow("--mode must be full or incremental")
  })
})
