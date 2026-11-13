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

// GitHub serves any commit of a repository's forks at the repository's own
// address. A Brick is whose its address says, and an instance takes a newer
// revision from that address, so a catalog on GitHub is only ever read at a
// commit the repository itself published.
describe("a catalog on GitHub", () => {
  const published = "a".repeat(40)
  const forked = "f".repeat(40)
  const api = "https://api.github.com/repos/billy/bricks"
  const raw = "https://raw.githubusercontent.com/billy/bricks"
  const recipe = (id: string) =>
    [
      "format: kiln.brick/v2",
      "kind: game-server",
      `metadata: { id: ${id}, name: ${id}, summary: An example., author: Billy }`,
      "deploy: { type: image, image: ghcr.io/acme/game:1 }",
      "",
    ].join("\n")
  const github = (recipes: ReadonlyArray<string> = ["bricks/paper.yml"]) => {
    remote.asked.length = 0
    remote.answers.clear()
    remote.answers.set(`${api}/commits/HEAD`, `{"sha":"${published}"}`)
    remote.answers.set(`${api}/commits/heads/main`, `{"sha":"${published}"}`)
    remote.answers.set(`${api}/commits/tags/v1`, `{"sha":"${published}"}`)
    // What GitHub answers for any commit of a fork, and for a pull request.
    remote.answers.set(`${api}/commits/${forked}`, `{"sha":"${forked}"}`)
    remote.answers.set(`${api}/commits/pull`, `{"sha":"${forked}"}`)
    for (const commit of [published, forked]) {
      remote.answers.set(
        `${raw}/${commit}/catalog.yml`,
        [
          "format: kiln.catalog/v1",
          "name: Billy's",
          "recipes:",
          ...recipes.map((entry) => `  - ${entry}`),
          "",
        ].join("\n")
      )
      remote.answers.set(`${raw}/${commit}/bricks/paper.yml`, recipe("paper"))
    }
  }
  const sources = async (catalog: string) =>
    (await loadBrickCatalogSource(catalog)).snapshot.bricks.map(
      (brick) => brick.source
    )

  it("is read at its default branch, or a branch or tag of its own", async () => {
    for (const catalog of [
      "billy/bricks",
      `${raw}/main/catalog.yml`,
      `${raw}/v1/catalog.yml`,
    ]) {
      github()
      expect(await sources(catalog)).toEqual([
        `${raw}/${published}/bricks/paper.yml`,
      ])
    }
  })

  it("is never read at a commit by its ID, or at a pull request's", async () => {
    // Nor by anything Git reads as a way to reach one.
    for (const commit of [
      forked,
      forked.slice(0, 7),
      published,
      `${forked}~0`,
      `${forked}^0`,
      "main~1",
      "main@{1}",
    ]) {
      github()
      await expect(sources(`${raw}/${commit}/catalog.yml`)).rejects.toThrow(
        "not a commit"
      )
      expect(remote.asked).toEqual([])
    }
    // A pull request's ref holds a fork's commits; only branches and tags
    // are looked up by name.
    github()
    await expect(sources(`${raw}/pull/catalog.yml`)).rejects.toThrow(
      "isn't a branch or tag of billy/bricks"
    )
    expect(remote.asked.filter((asked) => asked.startsWith(raw))).toEqual([])
  })

  it("lists no recipe from another repository on GitHub, nor from another commit of its own", async () => {
    const theirs = `https://raw.githubusercontent.com/kiln-site/kiln/${forked}/apps/bricks/bricks/paper.yml`
    for (const elsewhere of [
      theirs,
      `${raw}/${forked}/bricks/paper.yml`,
      `../../../kiln-site/kiln/${forked}/apps/bricks/bricks/paper.yml`,
    ]) {
      github([elsewhere])
      remote.answers.set(theirs, recipe("paper"))
      await expect(sources("billy/bricks")).rejects.toThrow(
        "listed by a catalog of its own repository"
      )
      expect(remote.asked.filter((asked) => asked.includes(forked))).toEqual([])
    }
    // Nor does a catalog kept anywhere else.
    remote.asked.length = 0
    remote.answers.clear()
    remote.answers.set(
      "https://bricks.test/billy/catalog.yml",
      `format: kiln.catalog/v1\nname: Billy's\nrecipes:\n  - ${theirs}\n`
    )
    remote.answers.set(theirs, recipe("paper"))
    await expect(
      sources("https://bricks.test/billy/catalog.yml")
    ).rejects.toThrow("listed by a catalog of its own repository")
    expect(remote.asked).not.toContain(theirs)
  })
})
