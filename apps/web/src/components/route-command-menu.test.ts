import { describe, expect, it } from "vite-plus/test"

import { filterRoutes } from "@/components/route-command-menu"

describe("route command filtering", () => {
  it("rejects weak scattered-character matches", () => {
    expect(
      filterRoutes("/backups", "paper", [
        "Backups",
        "manage",
        "restore",
        "snapshots",
      ])
    ).toBe(0)
    expect(
      filterRoutes("/settings/appearance", "paper", [
        "Appearance",
        "settings",
        "theme",
        "color",
      ])
    ).toBe(0)
  })

  it("accepts close typos in route words", () => {
    expect(
      filterRoutes("/infra/databases", "databse", [
        "Databases",
        "infrastructure",
        "mysql",
      ])
    ).toBeGreaterThan(0)
  })

  it("matches selected-server aliases", () => {
    expect(
      filterRoutes("/server/1047601c/console", "paper", [
        "Console",
        "server",
        "Paper Server",
        "Paper",
        "terminal",
      ])
    ).toBeGreaterThan(0)
  })
})
