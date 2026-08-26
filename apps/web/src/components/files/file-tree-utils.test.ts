import { describe, expect, it } from "vite-plus/test"

import {
  isUnarchiveSupportedPath,
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
  })
})
