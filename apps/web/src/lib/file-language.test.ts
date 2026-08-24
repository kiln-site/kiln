import { describe, expect, it } from "vite-plus/test"

import { fileLanguageForPath } from "./file-language"

describe("file language detection", () => {
  it.each(["player.dat", "level.dat_old", "structure.nbt", "data.snbt"])(
    "recognizes %s as SNBT",
    (path) => {
      expect(fileLanguageForPath(path)).toEqual({ id: "snbt", label: "SNBT" })
    }
  )
})
