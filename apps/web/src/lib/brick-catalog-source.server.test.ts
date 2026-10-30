import { describe, expect, it } from "vite-plus/test"

import { loadBrickCatalogSource } from "./brick-catalog-source.server"

describe("Hearth Brick catalogs", () => {
  it("does not allow personal file catalogs", async () => {
    await expect(
      loadBrickCatalogSource("file:///tmp/catalog.yml")
    ).rejects.toThrow("Personal catalogs must use HTTPS")
  })

  it("blocks IPv4-mapped private catalog addresses", async () => {
    await expect(
      loadBrickCatalogSource("https://[::ffff:7f00:1]/catalog.yml")
    ).rejects.toThrow("private or reserved address")
  })
})
