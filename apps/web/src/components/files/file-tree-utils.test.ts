import { describe, expect, it } from "vite-plus/test"

import {
  isUnarchiveSupportedPath,
  movedFilePath,
  unarchiveDestinationPath,
} from "@/components/files/file-tree-utils"

describe("file archive paths", () => {
  it("recognizes ZIP and compressed TAR files", () => {
    expect(isUnarchiveSupportedPath("world/config.zip")).toBe(true)
    expect(isUnarchiveSupportedPath("world/config.TAR.GZ")).toBe(true)
    expect(isUnarchiveSupportedPath("world/config.tgz")).toBe(true)
    expect(isUnarchiveSupportedPath("world/config.tar")).toBe(false)
    expect(isUnarchiveSupportedPath("world/config.zip/")).toBe(false)
  })

  it("uses the archive stem as the automatic destination", () => {
    expect(unarchiveDestinationPath("world/config.zip")).toBe("world/config")
    expect(unarchiveDestinationPath("world/config.tar.gz")).toBe("world/config")
    expect(unarchiveDestinationPath("world/config.tgz")).toBe("world/config")
    expect(unarchiveDestinationPath("world/config.v1.zip")).toBe(
      "world/config.v1"
    )
  })
})

// After a move the editor follows the new path; a wrong answer would let a
// later save write to the old location.
describe("moved file paths", () => {
  it("follows the moved file and everything inside a moved folder", () => {
    expect(
      movedFilePath(
        "server.properties",
        "server.properties",
        "config/server.properties"
      )
    ).toBe("config/server.properties")
    expect(
      movedFilePath("world/region/r.0.0.mca", "world/", "backups/world/")
    ).toBe("backups/world/region/r.0.0.mca")
  })

  it("leaves paths that only share a name prefix alone", () => {
    expect(
      movedFilePath("world_nether/level.dat", "world/", "old/world/")
    ).toBeNull()
    expect(movedFilePath("world.txt", "world", "old/world")).toBeNull()
    expect(movedFilePath("world/level.dat", "world", "old/world")).toBeNull()
  })
})
