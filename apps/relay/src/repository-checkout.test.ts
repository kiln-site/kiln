import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { gzipSync } from "node:zlib"

import { pack } from "tar-stream"
import { afterEach, describe, expect, it } from "vite-plus/test"

import {
  checkoutFile,
  extractRepositoryArchive,
} from "./repository-checkout.js"

type Entry =
  | { name: string; body: string }
  | { name: string; type: "directory" }
  | { name: string; type: "symlink"; linkname: string }

const directories: Array<string> = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true })
  }
})

// A gzipped tarball shaped like GitHub's: everything under one top folder.
async function archive(entries: ReadonlyArray<Entry>): Promise<Readable> {
  const packer = pack()
  const chunks: Array<Buffer> = []
  packer.on("data", (chunk: unknown) => {
    chunks.push(Buffer.from(chunk as Uint8Array))
  })
  const done = new Promise<void>((resolve) => packer.on("end", () => resolve()))
  for (const entry of entries) {
    if ("body" in entry) {
      packer.entry({ mode: 0o644, name: entry.name }, entry.body)
    } else if (entry.type === "symlink") {
      packer.entry({
        linkname: entry.linkname,
        name: entry.name,
        type: "symlink",
      })
    } else {
      packer.entry({ name: entry.name, type: "directory" })
    }
  }
  packer.finalize()
  await done
  return Readable.from([gzipSync(Buffer.concat(chunks))])
}

async function checkout(entries: ReadonlyArray<Entry>) {
  const parent = await mkdtemp(join(tmpdir(), "kiln-checkout-"))
  directories.push(parent)
  const destination = join(parent, "checkout")
  const summary = await extractRepositoryArchive(
    await archive(entries),
    destination,
    new AbortController().signal
  )
  return { destination, parent, summary }
}

describe("repository checkouts", () => {
  it("leaves out entries that would land outside the checkout", async () => {
    const { destination, parent, summary } = await checkout([
      { name: "acme-site-0123abc/", type: "directory" },
      { body: "escaped", name: "acme-site-0123abc/../../escaped" },
      { body: "absolute", name: "/tmp/absolute" },
      { body: "kept", name: "acme-site-0123abc/kept.txt" },
    ])

    expect(summary.files).toBe(1)
    await expect(lstat(join(parent, "escaped"))).rejects.toThrow()
    await expect(lstat(join(destination, "..", "escaped"))).rejects.toThrow()
    expect(await readFile(join(destination, "kept.txt"), "utf8")).toBe("kept")
  })

  it("keeps links inside the checkout and drops those that lead out, even through other links", async () => {
    const { destination, summary } = await checkout([
      { name: "repo-sha/", type: "directory" },
      { name: "repo-sha/config/", type: "directory" },
      { body: "server {}", name: "repo-sha/config/nginx.conf" },
      { name: "repo-sha/nested/", type: "directory" },
      {
        linkname: "config/nginx.conf",
        name: "repo-sha/nginx.conf",
        type: "symlink",
      },
      { linkname: "/etc/passwd", name: "repo-sha/passwd", type: "symlink" },
      { linkname: "../../..", name: "repo-sha/up", type: "symlink" },
      // Each looks inside on its own; together they lead above the checkout.
      { linkname: "..", name: "repo-sha/nested/root", type: "symlink" },
      {
        linkname: "nested/root/..",
        name: "repo-sha/escape",
        type: "symlink",
      },
      { linkname: "x", name: "repo-sha/escape/written", type: "symlink" },
    ])

    expect(await readlink(join(destination, "nginx.conf"))).toBe(
      "config/nginx.conf"
    )
    expect(await readlink(join(destination, "nested/root"))).toBe("..")
    for (const dropped of ["passwd", "up", "escape"]) {
      await expect(lstat(join(destination, dropped))).rejects.toThrow()
    }
    expect(summary.skipped).toBe(4)
  })

  it("finds a Dockerfile or Compose file only inside the checkout", async () => {
    const { destination } = await checkout([
      { name: "repo-sha/", type: "directory" },
      { body: "services: {}\n", name: "repo-sha/compose.yaml" },
      { name: "repo-sha/deploy/", type: "directory" },
      {
        linkname: "../compose.yaml",
        name: "repo-sha/deploy/compose.yaml",
        type: "symlink",
      },
    ])

    const compose = join(await realpath(destination), "compose.yaml")
    expect(await checkoutFile(destination, "compose.yaml")).toBe(compose)
    expect(await checkoutFile(destination, "deploy/compose.yaml")).toBe(compose)
    expect(await checkoutFile(destination, "../outside.yaml")).toBeNull()
    expect(await checkoutFile(destination, "missing.yaml")).toBeNull()
    expect(await checkoutFile(destination, "deploy")).toBeNull()
  })
})
