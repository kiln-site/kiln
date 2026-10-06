import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Fiber } from "effect"
import { createHash } from "node:crypto"
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, vi } from "vite-plus/test"

import { CliInstallation, updateCliEffect } from "./update.js"

const repository = "https://github.com/example/panel"
// The downloaded "binary" is a script so the real `--version` check runs.
const binary = (version: string, prelude = "") =>
  Buffer.from(`#!/bin/sh\n${prelude}echo 'kiln ${version}'\n`)
const sha256 = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`

function release(
  version = "1.1.0",
  bytes = binary(version),
  asset = `kiln-v${version}-linux-x64`
) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: version.includes("nightly"),
    assets: [
      {
        name: asset,
        size: bytes.length,
        digest: sha256(bytes),
        browser_download_url: `${repository}/releases/download/v${version}/${asset}`,
      },
    ],
  }
}

// Fakes GitHub at the network boundary: release metadata, then the asset.
function stubGitHub(
  metadata: unknown,
  download: (init?: RequestInit) => Response | Promise<Response>
) {
  const requests: Array<string> = []
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    requests.push(String(url))
    return String(url).startsWith("https://api.github.com/")
      ? Response.json(metadata)
      : download(init)
  })
  return requests
}

async function fixture(
  run: (directory: string, target: string) => Promise<void>
) {
  const directory = await mkdtemp(join(tmpdir(), "kiln-update-test-"))
  const target = join(directory, "kiln")
  await writeFile(target, "old binary", { mode: 0o755 })
  try {
    await run(directory, target)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function update(
  executablePath: string,
  overrides: Partial<Context.Service.Shape<typeof CliInstallation>> = {}
) {
  return updateCliEffect().pipe(
    Effect.provideService(CliInstallation, {
      arch: "x64",
      currentVersion: "1.0.0",
      executablePath,
      platform: "linux",
      repository,
      standalone: true,
      ...overrides,
    })
  )
}

describe("CLI GitHub updates", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("updates the actual executable behind a symlink using its embedded repository", async () => {
    await fixture(async (directory, target) => {
      const link = join(directory, "kiln-link")
      await symlink(target, link)
      const bytes = binary("1.1.0")
      const requests = stubGitHub(release(), () => new Response(bytes))

      const result = await Effect.runPromise(update(link))

      assert.deepEqual(result, { updated: true, version: "1.1.0" })
      assert.deepEqual(await readFile(target), bytes)
      assert.strictEqual(
        requests[0],
        "https://api.github.com/repos/example/panel/releases/latest"
      )
      assert.deepEqual((await readdir(directory)).sort(), ["kiln", "kiln-link"])
    })
  })

  it("preserves nightly channel and never downgrades", async () => {
    await fixture(async (_, target) => {
      stubGitHub(
        [release("1.2.0"), release("1.1.0-nightly.20261004.000000")],
        () => new Response(binary("1.2.0"))
      )
      const currentVersion = "1.1.0-nightly.20261005.000000"

      assert.deepEqual(
        await Effect.runPromise(update(target, { currentVersion })),
        { updated: false, version: currentVersion }
      )
      assert.equal(await readFile(target, "utf8"), "old binary")
    })
  })

  it("leaves the installation untouched for missing, foreign, or corrupt downloads", async () => {
    for (const kind of [
      "missing",
      "foreign",
      "digest",
      "truncated",
      "version",
      "http",
    ]) {
      await fixture(async (directory, target) => {
        const wrongVersion = binary("9.9.9")
        const metadata =
          kind === "version" ? release("1.1.0", wrongVersion) : release()
        if (kind === "missing") metadata.assets = []
        if (kind === "foreign")
          metadata.assets[0]!.browser_download_url =
            "https://github.com/other/repo/asset"
        if (kind === "digest")
          metadata.assets[0]!.digest = `sha256:${"0".repeat(64)}`
        stubGitHub(metadata, () => {
          if (kind === "truncated") return new Response("bad")
          if (kind === "http") return new Response("bad", { status: 503 })
          if (kind === "version") return new Response(wrongVersion)
          return new Response(binary("1.1.0"))
        })

        const error = await Effect.runPromise(update(target).pipe(Effect.flip))

        assert.equal(error.code, "cli_update_failed", kind)
        assert.equal(await readFile(target, "utf8"), "old binary", kind)
        assert.deepEqual(await readdir(directory), ["kiln"], kind)
      })
    }
  })

  it("cancels a partial download without replacing the executable", async () => {
    await fixture(async (directory, target) => {
      let markDownloading: () => void = () => undefined
      const downloading = new Promise<void>((resolve) => {
        markDownloading = resolve
      })
      stubGitHub(release(), (init) => {
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(init.signal?.reason),
                { once: true }
              )
            },
            pull(controller) {
              controller.enqueue(binary("1.1.0").subarray(0, 1))
              markDownloading()
              return new Promise<void>(() => {})
            },
          },
          { highWaterMark: 0 }
        )
        return new Response(body)
      })

      const fiber = Effect.runFork(update(target))
      await downloading
      await Effect.runPromise(Fiber.interrupt(fiber))

      assert.equal(await readFile(target, "utf8"), "old binary")
      assert.deepEqual(await readdir(directory), ["kiln"])
    })
  })

  it("refuses overlapping updates", async () => {
    await fixture(async (directory, target) => {
      await writeFile(`${target}.update-lock`, "")
      stubGitHub(release(), () => new Response(binary("1.1.0")))

      const error = await Effect.runPromise(update(target).pipe(Effect.flip))

      assert.equal(error.code, "cli_update_failed")
      assert.equal(await readFile(target, "utf8"), "old binary")
      assert.deepEqual((await readdir(directory)).sort(), [
        "kiln",
        "kiln.update-lock",
      ])
    })
  })

  it("reclaims the lock left behind by a killed update", async () => {
    await fixture(async (directory, target) => {
      await writeFile(`${target}.update-lock`, "")
      const lastHour = new Date(Date.now() - 60 * 60 * 1000)
      await utimes(`${target}.update-lock`, lastHour, lastHour)
      const bytes = binary("1.1.0")
      stubGitHub(release(), () => new Response(bytes))

      const result = await Effect.runPromise(update(target))

      assert.deepEqual(result, { updated: true, version: "1.1.0" })
      assert.deepEqual(await readFile(target), bytes)
      assert.deepEqual(await readdir(directory), ["kiln"])
    })
  })

  it("rolls back the Windows executable if the replacement cannot be moved", async () => {
    await fixture(async (directory, target) => {
      // The staged binary passes verification and then removes itself, so the
      // final Windows rename fails after the running image was moved aside.
      const bytes = binary("1.1.0", 'rm -- "$0"\n')
      stubGitHub(
        release("1.1.0", bytes, "kiln-v1.1.0-windows-x64.exe"),
        () => new Response(bytes)
      )

      const error = await Effect.runPromise(
        update(target, { platform: "win32" }).pipe(Effect.flip)
      )

      assert.equal(error.code, "cli_update_failed")
      assert.equal(await readFile(target, "utf8"), "old binary")
      assert.deepEqual(await readdir(directory), ["kiln"])
    })
  })

  it("never updates the Node/Bun runtime from a source checkout", async () => {
    const requests = stubGitHub(release(), () => new Response("unused"))

    // The real installation: this test runner is not a standalone CLI binary.
    const error = await Effect.runPromise(updateCliEffect().pipe(Effect.flip))

    assert.equal(error.code, "cli_update_development")
    assert.deepEqual(requests, [])
  })
})
