import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import { loadBrickCatalogSource } from "./brick-catalog-source.server"

// The network is the only fake: what each HTTPS address answers, a document
// or a redirect, and which were asked for.
const remote = vi.hoisted(() => ({
  answers: new Map<string, string | { redirect: string }>(),
  asked: [] as Array<string>,
}))
vi.mock("node:https", async (importOriginal) => {
  const { PassThrough } = await import("node:stream")
  return {
    ...(await importOriginal<typeof import("node:https")>()),
    get: (
      url: URL,
      _options: unknown,
      respond: (response: unknown) => void
    ) => {
      remote.asked.push(url.href)
      const answer = remote.answers.get(url.href)
      const response = Object.assign(new PassThrough(), {
        headers:
          typeof answer === "object" ? { location: answer.redirect } : {},
        statusCode:
          answer === undefined ? 404 : typeof answer === "string" ? 200 : 302,
      })
      queueMicrotask(() => {
        respond(response)
        response.end(typeof answer === "string" ? answer : "")
      })
      return { once: () => undefined }
    },
  }
})

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

// A Brick can keep the Compose file or Dockerfile it runs beside its
// recipe. Hearth reads it when it loads the catalog, so it must be a file
// of that catalog and nothing else on the machine Hearth runs on.
describe("a file a Brick carries beside its recipe", () => {
  const directories: Array<string> = []
  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      await rm(directory, { force: true, recursive: true })
    }
  })
  const catalog = async (file: string) => {
    const root = await mkdtemp(join(tmpdir(), "kiln-catalog-"))
    directories.push(root)
    await mkdir(join(root, "catalog", "bricks"), { recursive: true })
    await writeFile(join(root, "outside.yaml"), "services: {}\n")
    await writeFile(
      join(root, "catalog", "bricks", "stack.kiln.compose.yaml"),
      "services:\n  web:\n    image: ghcr.io/acme/site:1\n"
    )
    await writeFile(
      join(root, "catalog", "bricks", "stack.yml"),
      [
        "format: kiln.brick/v2",
        "kind: app",
        "metadata: { id: stack, name: Stack, summary: An example., author: Kiln }",
        "deploy:",
        "  type: compose",
        `  file: ${file}`,
        "",
      ].join("\n")
    )
    await writeFile(
      join(root, "catalog", "bricks.yml"),
      "format: kiln.catalog/v1\nname: Test\nrecipes:\n  - bricks/stack.yml\n"
    )
    return pathToFileURL(join(root, "catalog", "bricks.yml")).href
  }

  it("is read into the Brick as the file it runs", async () => {
    const loaded = await loadBrickCatalogSource(
      await catalog("./stack.kiln.compose.yaml"),
      { allowFile: true }
    )
    expect(loaded.snapshot.bricks.map((brick) => brick.deploy)).toEqual([
      {
        compose: "services:\n  web:\n    image: ghcr.io/acme/site:1\n",
        type: "compose",
      },
    ])
  })

  it("is refused from outside its recipe's folder", async () => {
    for (const elsewhere of [
      "../../outside.yaml",
      "../outside.yaml",
      "https://example.com/compose.yaml",
    ]) {
      await expect(
        loadBrickCatalogSource(await catalog(elsewhere), { allowFile: true })
      ).rejects.toThrow("isn't beside its recipe")
    }
  })

  // A catalog on the web is read at one address, often a commit of a
  // repository. Its Brick's file is read there too: not from another
  // repository on the same host, straight or by a redirect.
  const published = (file: string) => {
    const root = "https://bricks.test/acme/catalog/1f0e"
    remote.asked.length = 0
    remote.answers.clear()
    remote.answers.set(
      `${root}/bricks.yml`,
      "format: kiln.catalog/v1\nname: Test\nrecipes:\n  - bricks/stack.yml\n"
    )
    remote.answers.set(
      `${root}/bricks/stack.yml`,
      [
        "format: kiln.brick/v2",
        "kind: app",
        "metadata: { id: stack, name: Stack, summary: An example., author: Kiln }",
        "deploy:",
        "  type: compose",
        `  file: ${file}`,
        "",
      ].join("\n")
    )
    remote.answers.set(
      `${root}/bricks/stack.kiln.compose.yaml`,
      "services:\n  web:\n    image: ghcr.io/acme/site:1\n"
    )
    remote.answers.set(
      "https://bricks.test/someone/else/main/compose.yaml",
      "services:\n  web:\n    image: ghcr.io/someone/else:latest\n"
    )
    remote.answers.set(`${root}/bricks/moved.yaml`, {
      redirect: "https://bricks.test/someone/else/main/compose.yaml",
    })
    return `${root}/bricks.yml`
  }

  it("is read from a catalog on the web, beside its recipe there", async () => {
    const loaded = await loadBrickCatalogSource(
      published("./stack.kiln.compose.yaml")
    )
    expect(loaded.snapshot.bricks.map((brick) => brick.deploy)).toEqual([
      {
        compose: "services:\n  web:\n    image: ghcr.io/acme/site:1\n",
        type: "compose",
      },
    ])
  })

  it("is never read from another repository on its catalog's host", async () => {
    const elsewhere = "https://bricks.test/someone/else/main/compose.yaml"
    await expect(
      loadBrickCatalogSource(
        published("../../../../someone/else/main/compose.yaml")
      )
    ).rejects.toThrow("isn't beside its recipe")
    await expect(
      loadBrickCatalogSource(published("./moved.yaml"))
    ).rejects.toThrow("redirected somewhere else")
    expect(remote.asked).not.toContain(elsewhere)
  })
})
