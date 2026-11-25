import { createReadStream, mkdtempSync, rmSync } from "node:fs"
import { chmod, link, mkdir, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGunzip, createZstdDecompress } from "node:zlib"

import { Effect } from "effect"
import { extract, type Header } from "tar-stream"
import { afterAll, expect, it } from "vite-plus/test"

import { tarTree } from "./tar-tree.js"

const directory = mkdtempSync(join(tmpdir(), "kiln-tar-tree-"))

afterAll(() => {
  rmSync(directory, { force: true, recursive: true })
})

async function contents(path: string, compression: "gzip" | "zstd") {
  const entries: Array<{ body: string; header: Header }> = []
  const tar = extract()
  createReadStream(path)
    .pipe(compression === "zstd" ? createZstdDecompress() : createGunzip())
    .pipe(tar as unknown as NodeJS.WritableStream)
  for await (const entry of tar) {
    const chunks: Array<Buffer> = []
    for await (const chunk of entry) chunks.push(chunk as Buffer)
    entries.push({
      body: Buffer.concat(chunks).toString("utf8"),
      header: entry.header,
    })
  }
  return entries
}

it.each(["gzip", "zstd"] as const)(
  "keeps folders, links, modes and empty files with %s",
  async (compression) => {
    const root = join(directory, `root-${compression}`)
    await mkdir(join(root, "world", "empty"), { recursive: true })
    await writeFile(join(root, "world", "level.dat"), "level")
    await chmod(join(root, "world", "level.dat"), 0o640)
    await writeFile(join(root, "world", "none"), "")
    await link(join(root, "world", "level.dat"), join(root, "world", "same"))
    await symlink("world", join(root, "current"))
    const destination = join(directory, `out-${compression}`)

    const written = await Effect.runPromise(
      tarTree(root, destination, { compression, onProgress: () => undefined })
    )

    expect((await stat(destination)).size).toBe(written.bytes)
    expect(
      (await contents(destination, compression)).map(({ body, header }) => [
        header.name,
        header.type,
        header.linkname,
        body,
      ])
    ).toEqual([
      ["current", "symlink", "world", ""],
      ["world/", "directory", null, ""],
      ["world/empty/", "directory", null, ""],
      ["world/level.dat", "file", null, "level"],
      ["world/none", "file", null, ""],
      ["world/same", "link", "world/level.dat", ""],
    ])
    expect(
      (await contents(destination, compression)).find(
        ({ header }) => header.name === "world/level.dat"
      )?.header.mode
    ).toBe(0o640)
  }
)
