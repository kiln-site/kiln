import { describe, expect, it } from "vite-plus/test"

import { movedFilePath } from "@/components/files/file-tree-utils"

// After a move the editor follows the new path; a wrong answer would let a
// later save write to the old location.
describe("moved file paths", () => {
  it("leaves paths that only share a name prefix alone", () => {
    expect(
      movedFilePath("world_nether/level.dat", "world/", "old/world/")
    ).toBeNull()
    expect(movedFilePath("world.txt", "world", "old/world")).toBeNull()
    expect(movedFilePath("world/level.dat", "world", "old/world")).toBeNull()
  })
})
