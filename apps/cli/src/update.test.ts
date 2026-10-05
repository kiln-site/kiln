import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { createHash } from "node:crypto"
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  isStandaloneCliBinary,
  replaceBinary,
  updateCliEffect,
} from "./update.js"

const repository = "https://github.com/example/panel"
const bytes = Buffer.from("new binary")
const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
function release(version = "1.1.0", overrides = {}) {
  const name = `kiln-v${version}-linux-x64`
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: version.includes("nightly"),
    assets: [
      {
        name,
        size: bytes.length,
        digest: sha256,
        browser_download_url: `${repository}/releases/download/v${version}/${name}`,
      },
    ],
    ...overrides,
  }
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

function options(target: string, response = release()) {
  const requests: string[] = []
  return {
    currentVersion: "1.0.0",
    repository,
    executablePath: target,
    platform: "linux" as const,
    arch: "x64",
    isStandaloneBinary: () => true,
    verifyBinary: async () => {},
    fetch: (async (url) => {
      requests.push(String(url))
      return String(url).startsWith("https://api.github.com/")
        ? Response.json(response)
        : new Response(bytes)
    }) as typeof fetch,
    requests,
  }
}

describe("CLI GitHub updates", () => {
  it("updates the actual executable behind a symlink using its embedded repository", async () => {
    await fixture(async (directory, target) => {
      const link = join(directory, "kiln-link")
      await symlink(target, link)
      const input = options(link)
      let verified = false
      input.verifyBinary = async () => {
        verified = true
      }
      const result = await Effect.runPromise(updateCliEffect(input))
      assert.deepEqual(result, { updated: true, version: "1.1.0" })
      assert.isTrue(verified)
      assert.equal(await readFile(target, "utf8"), "new binary")
      assert.deepEqual(input.requests, [
        `${repository.replace("github.com", "api.github.com/repos")}/releases/latest`,
        release().assets[0]!.browser_download_url,
      ])
      assert.deepEqual((await readdir(directory)).sort(), ["kiln", "kiln-link"])
    })
  })

  it("preserves nightly channel and never downgrades", async () => {
    await fixture(async (_, target) => {
      const input = options(target)
      input.currentVersion = "1.1.0-nightly.20261005.000000"
      input.fetch = (async (url) => {
        input.requests.push(String(url))
        return Response.json([
          release("1.2.0"),
          release("1.1.0-nightly.20261004.000000"),
        ])
      }) as typeof fetch
      assert.deepEqual(await Effect.runPromise(updateCliEffect(input)), {
        updated: false,
        version: input.currentVersion,
      })
      assert.match(input.requests[0]!, /releases\?per_page=100$/u)
      assert.equal(input.requests.length, 1)
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
        const metadata = release()
        if (kind === "missing") metadata.assets = []
        if (kind === "foreign")
          metadata.assets[0]!.browser_download_url =
            "https://github.com/other/repo/asset"
        if (kind === "digest")
          metadata.assets[0]!.digest = `sha256:${"0".repeat(64)}`
        const input = options(target, metadata)
        if (kind === "version")
          input.verifyBinary = async () => {
            throw new Error("wrong version")
          }
        if (kind === "truncated" || kind === "http") {
          input.fetch = (async (url) =>
            String(url).startsWith("https://api.github.com/")
              ? Response.json(metadata)
              : new Response("bad", {
                  status: kind === "http" ? 503 : 200,
                })) as typeof fetch
        }
        const error = await Effect.runPromise(
          updateCliEffect(input).pipe(Effect.flip)
        )
        assert.equal(error.code, "cli_update_failed", kind)
        assert.equal(await readFile(target, "utf8"), "old binary", kind)
        assert.deepEqual(await readdir(directory), ["kiln"], kind)
      })
    }
  })

  it("cancels a partial download without replacing the executable", async () => {
    await fixture(async (directory, target) => {
      let downloadStarted = () => {}
      const downloading = new Promise<void>((resolve) => {
        downloadStarted = resolve
      })
      const input = options(target)
      input.fetch = (async (url, init) => {
        if (String(url).startsWith("https://api.github.com/"))
          return Response.json(release())
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
              controller.enqueue(bytes.subarray(0, 1))
              downloadStarted()
              return new Promise<void>(() => {})
            },
          },
          { highWaterMark: 0 }
        )
        return new Response(body)
      }) as typeof fetch
      const fiber = Effect.runFork(updateCliEffect(input))
      await downloading
      fiber.interruptUnsafe()
      await Effect.runPromise(Fiber.await(fiber))
      assert.equal(await readFile(target, "utf8"), "old binary")
      assert.deepEqual(await readdir(directory), ["kiln"])
    })
  })

  it("refuses overlapping updates before downloading", async () => {
    await fixture(async (directory, target) => {
      await writeFile(`${target}.update-lock`, "")
      const input = options(target)
      await Effect.runPromise(updateCliEffect(input).pipe(Effect.flip))
      assert.equal(input.requests.length, 1)
      assert.equal(await readFile(target, "utf8"), "old binary")
      assert.include(await readdir(directory), "kiln.update-lock")
    })
  })

  it("rolls back the Windows executable if the replacement cannot be moved", async () => {
    await fixture(async (directory, target) => {
      const error = await Effect.runPromise(
        replaceBinary(`${target}.missing`, target, "win32").pipe(Effect.flip)
      )
      assert.equal(error.code, "cli_update_failed")
      assert.equal(await readFile(target, "utf8"), "old binary")
      assert.deepEqual(await readdir(directory), ["kiln"])
    })
  })

  it("never updates the Node/Bun runtime from a source checkout", async () => {
    const error = await Effect.runPromise(
      updateCliEffect({ isStandaloneBinary: () => false }).pipe(Effect.flip)
    )
    assert.equal(error.code, "cli_update_development")
    assert.isTrue(isStandaloneCliBinary("/$bunfs/root/kiln"))
    assert.isTrue(isStandaloneCliBinary("B:\\~BUN\\root\\kiln.exe"))
    assert.isFalse(
      isStandaloneCliBinary("/usr/local/lib/node_modules/kiln-cli/kiln.cjs")
    )
  })
})
