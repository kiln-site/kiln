import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
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
  | { name: string; body: string; mode?: number }
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
      packer.entry({ mode: entry.mode ?? 0o644, name: entry.name }, entry.body)
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
  it("unpacks the commit without GitHub's top folder, keeping executable bits", async () => {
    const { destination, summary } = await checkout([
      { name: "acme-site-0123abc/", type: "directory" },
      { body: "FROM node:22\n", name: "acme-site-0123abc/Dockerfile" },
      { name: "acme-site-0123abc/bin/", type: "directory" },
      {
        body: "#!/bin/sh\n",
        mode: 0o755,
        name: "acme-site-0123abc/bin/start.sh",
      },
    ])

    expect(summary).toEqual({ files: 2, skipped: 0 })
    // A container running as any user can read files bound from it.
    expect((await stat(destination)).mode & 0o777).toBe(0o755)
    expect(await readFile(join(destination, "Dockerfile"), "utf8")).toBe(
      "FROM node:22\n"
    )
    expect((await stat(join(destination, "bin/start.sh"))).mode & 0o111).toBe(
      0o111
    )
  })

  it("leaves every folder and file readable by any user under a restrictive umask", async () => {
    const previous = process.umask(0o077)
    const unpacked = await checkout([
      { name: "repo-sha/", type: "directory" },
      { body: "<h1>hi</h1>", name: "repo-sha/public/site/index.html" },
      { name: "repo-sha/config/", type: "directory" },
    ]).finally(() => process.umask(previous))
    const mode = async (path: string) =>
      (await stat(join(unpacked.destination, path))).mode & 0o777

    expect(await mode("public")).toBe(0o755)
    expect(await mode("public/site")).toBe(0o755)
    expect(await mode("config")).toBe(0o755)
    expect(await mode("public/site/index.html")).toBe(0o644)
  })

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

  it("keeps a chain of links whichever order the archive lists them in", async () => {
    const { destination, summary } = await checkout([
      { name: "repo-sha/", type: "directory" },
      { name: "repo-sha/releases/", type: "directory" },
      { name: "repo-sha/releases/v1/", type: "directory" },
      { body: "<h1>v1</h1>", name: "repo-sha/releases/v1/index.html" },
      // Leads through a link the archive only lists after it.
      {
        linkname: "releases/latest",
        name: "repo-sha/current",
        type: "symlink",
      },
      { linkname: "v1", name: "repo-sha/releases/latest", type: "symlink" },
      {
        linkname: "current/index.html",
        name: "repo-sha/home.html",
        type: "symlink",
      },
    ])

    expect(summary.skipped).toBe(0)
    expect(await readFile(join(destination, "home.html"), "utf8")).toBe(
      "<h1>v1</h1>"
    )
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

  it("refuses an archive it can't read", async () => {
    const parent = await mkdtemp(join(tmpdir(), "kiln-checkout-"))
    directories.push(parent)
    await expect(
      extractRepositoryArchive(
        Readable.from([Buffer.from("not a tarball")]),
        join(parent, "checkout"),
        new AbortController().signal
      )
    ).rejects.toThrow("The repository's archive could not be read")
  })
})
