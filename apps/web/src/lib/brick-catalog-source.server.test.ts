import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vite-plus/test"

import {
  brickIconRetryDelay,
  githubCatalogRevisionUrl,
  loadBrickCatalogSource,
} from "./brick-catalog-source.server"

const directories: Array<string> = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

describe("Hearth Brick catalogs", () => {
  it("resolves, validates, and snapshots relative recipes", async () => {
    const directory = await temporaryDirectory()
    await writeFile(
      resolve(directory, "catalog.yml"),
      `format: kiln.catalog/v1
name: Example Catalog
author: Example Author
docs: https://example.com/docs
support: https://example.com/support
recipes: [paper.yml]
`
    )
    await writeFile(resolve(directory, "paper.yml"), recipe("paper", "Paper"))

    const loaded = await loadBrickCatalogSource(
      pathToFileURL(resolve(directory, "catalog.yml")).href,
      { allowFile: true }
    )

    expect(loaded.snapshot.bricks).toHaveLength(1)
    expect(loaded.snapshot).toMatchObject({
      name: "Example Catalog",
      author: "Example Author",
      docs: "https://example.com/docs",
      support: "https://example.com/support",
    })
    expect(loaded.snapshot.bricks[0]?.metadata.id).toBe("paper")
    expect(loaded.snapshot.bricks[0]?.source).toBe(
      pathToFileURL(resolve(directory, "paper.yml")).href
    )
    expect(loaded.snapshotSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it("snapshots a safe recipe-relative SVG icon", async () => {
    const directory = await temporaryDirectory()
    await writeFile(
      resolve(directory, "catalog.yml"),
      "format: kiln.catalog/v1\nrecipes: [recipes/paper.yml]\n"
    )
    await writeFile(
      resolve(directory, "recipes", "paper.yml"),
      recipe("paper", "Paper").replace(
        "  author: Kiln",
        '  author: Kiln\n  icon: ../icons/paper.svg\n  color: "#e67e7e"'
      )
    )
    await writeFile(
      resolve(directory, "icons", "paper.svg"),
      '<svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>'
    )

    const loaded = await loadBrickCatalogSource(
      pathToFileURL(resolve(directory, "catalog.yml")).href,
      { allowFile: true }
    )

    expect(loaded.snapshot.bricks[0]).toMatchObject({
      iconSvg: expect.stringContaining('viewBox="0 0 24 24"'),
      metadata: {
        color: "#e67e7e",
        icon: pathToFileURL(resolve(directory, "icons", "paper.svg")).href,
      },
    })
  })

  it("keeps a Brick usable when its icon cannot load", async () => {
    const directory = await temporaryDirectory()
    await writeFile(
      resolve(directory, "catalog.yml"),
      "format: kiln.catalog/v1\nrecipes: [paper.yml]\n"
    )
    await writeFile(
      resolve(directory, "paper.yml"),
      recipe("paper", "Paper").replace(
        "  author: Kiln",
        "  author: Kiln\n  icon: missing.svg"
      )
    )

    const loaded = await loadBrickCatalogSource(
      pathToFileURL(resolve(directory, "catalog.yml")).href,
      { allowFile: true }
    )

    expect(loaded.snapshot.bricks[0]?.metadata.id).toBe("paper")
    expect(loaded.snapshot.bricks[0]?.iconSvg).toBeUndefined()
  })

  it.each([
    "http://example.com/icon.svg",
    "data:image/svg+xml,<svg></svg>",
    "https://[",
  ])("keeps a Brick usable with an unusable icon URL: %s", async (icon) => {
    const directory = await temporaryDirectory()
    await writeFile(
      resolve(directory, "catalog.yml"),
      "format: kiln.catalog/v1\nrecipes: [paper.yml]\n"
    )
    await writeFile(
      resolve(directory, "paper.yml"),
      recipe("paper", "Paper").replace(
        "  author: Kiln",
        `  author: Kiln\n  icon: ${JSON.stringify(icon)}\n  color: "#e67e7e"`
      )
    )

    const loaded = await loadBrickCatalogSource(
      pathToFileURL(resolve(directory, "catalog.yml")).href,
      { allowFile: true }
    )

    expect(loaded.snapshot.bricks[0]).toMatchObject({
      metadata: { color: "#e67e7e", id: "paper" },
    })
    expect(loaded.snapshot.bricks[0]?.metadata.icon).toBeUndefined()
    expect(loaded.snapshot.bricks[0]?.iconSvg).toBeUndefined()
  })

  it("backs off repeated icon failures after a few quick retries", () => {
    expect(
      Array.from({ length: 6 }, (_, failures) => brickIconRetryDelay(failures))
    ).toEqual([2_000, 10_000, 60_000, 900_000, 900_000, 900_000])
  })

  it("rejects duplicate Brick ids within one catalog", async () => {
    const directory = await temporaryDirectory()
    await writeFile(
      resolve(directory, "catalog.yml"),
      "format: kiln.catalog/v1\nrecipes: [one.yml, two.yml]\n"
    )
    await writeFile(resolve(directory, "one.yml"), recipe("paper", "One"))
    await writeFile(resolve(directory, "two.yml"), recipe("paper", "Two"))

    await expect(
      loadBrickCatalogSource(
        pathToFileURL(resolve(directory, "catalog.yml")).href,
        { allowFile: true }
      )
    ).rejects.toThrow("duplicate Brick id paper")
  })

  it("preserves and reports Brick ids beyond the recommended length", async () => {
    const directory = await temporaryDirectory()
    await writeFile(
      resolve(directory, "catalog.yml"),
      "format: kiln.catalog/v1\nrecipes: [long.yml]\n"
    )
    await writeFile(
      resolve(directory, "long.yml"),
      recipe("abcdefghijklmnopqrst-extra", "Long id")
    )

    const loaded = await loadBrickCatalogSource(
      pathToFileURL(resolve(directory, "catalog.yml")).href,
      { allowFile: true }
    )

    expect(loaded.snapshot.bricks[0]?.metadata.id).toBe(
      "abcdefghijklmnopqrst-extra"
    )
    expect(loaded.overlongBrickIds).toEqual(["abcdefghijklmnopqrst-extra"])
  })

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

  it("links GitHub snapshots to the catalog file at the pinned commit", () => {
    expect(
      githubCatalogRevisionUrl(
        "https://github.com/kiln-site/kiln",
        "4d64d6d2b24162440655b822bb907f76fdda73c3",
        "apps/bricks/catalog.yml"
      )
    ).toBe(
      "https://github.com/kiln-site/kiln/blob/4d64d6d2b24162440655b822bb907f76fdda73c3/apps/bricks/catalog.yml"
    )
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kiln-hearth-catalog-"))
  directories.push(directory)
  await Promise.all([
    mkdir(resolve(directory, "icons"), { recursive: true }),
    mkdir(resolve(directory, "recipes"), { recursive: true }),
  ])
  return directory
}

function recipe(id: string, name: string): string {
  return `format: kiln.brick/v1
metadata:
  id: ${id}
  name: ${name}
  description: Test recipe
  game: Minecraft
  author: Kiln
variables: {}
runtime:
  image: example.test/server:latest
  name: Test
  environment: {}
  resources: { memory: 1G, pids: 128 }
  storage: { mount: /server }
network:
  mode: direct
  primaryPort: game
  ports:
    - { name: game, container: 25565, protocol: tcp }
`
}
