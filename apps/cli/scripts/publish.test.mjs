import assert from "node:assert/strict"
import { join } from "node:path"
import { afterEach, it, vi } from "vite-plus/test"

import { dist, packageName, platforms, version } from "./distribution.mjs"
import { publishPackages } from "./publish.mjs"

afterEach(() => vi.useRealTimers())

function packageSpec(source) {
  const name =
    source === join(dist, "npm")
      ? packageName
      : `${packageName}-${platforms.find((platform) => source.includes(`${platform.name}-`)).name}`
  return `${name}@${version}`
}

it("starts every native upload concurrently and publishes the launcher last", async () => {
  const started = Promise.withResolvers()
  const uploads = []
  const published = new Set()
  let launcherPublished = false
  const publishing = publishPackages(async ([command, source]) => {
    if (command === "view") return published.has(source) ? `${version}\n` : ""
    if (source === join(dist, "npm")) {
      assert.ok(uploads.every((upload) => upload.finished))
      launcherPublished = true
      published.add(packageSpec(source))
      return ""
    }
    const pending = Promise.withResolvers()
    const upload = { ...pending, finished: false }
    uploads.push(upload)
    if (uploads.length === platforms.length) started.resolve()
    await upload.promise
    upload.finished = true
    published.add(packageSpec(source))
    return ""
  })

  // No upload may need another upload to finish before it can start.
  await started.promise
  assert.equal(launcherPublished, false)
  for (const upload of uploads) upload.resolve()
  await publishing
  assert.equal(launcherPublished, true)
})

it("waits for native uploads to settle and blocks the launcher on failure", async () => {
  const started = Promise.withResolvers()
  const remaining = Promise.withResolvers()
  const failure = new Error("registry rejected a native package")
  const published = new Set()
  let nativeUploads = 0
  let finished = false
  let launcherPublished = false
  const publishing = publishPackages(async ([command, source]) => {
    if (command === "view") return published.has(source) ? `${version}\n` : ""
    if (source === join(dist, "npm")) launcherPublished = true
    nativeUploads += 1
    if (nativeUploads === platforms.length) started.resolve()
    if (nativeUploads === 1) throw failure
    await remaining.promise
    finished = true
    published.add(packageSpec(source))
    return ""
  })
  const rejected = assert.rejects(publishing, (error) => {
    assert.ok(finished)
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [failure])
    return true
  })

  await started.promise
  assert.equal(launcherPublished, false)
  remaining.resolve()
  await rejected
  assert.equal(launcherPublished, false)
})

it("retries only unpublished packages, including normalized registry versions", async () => {
  const missingPlatform = platforms[0].name
  const published = []
  const visible = new Set()
  await publishPackages(async ([command, source]) => {
    if (command === "view") {
      if (visible.has(source)) return `${version}\n`
      if (source.startsWith(`${packageName}-${missingPlatform}@`)) return ""
      if (source.startsWith(`${packageName}@`)) return ""
      return "0.1.0-nightly.20261005.84700\n"
    }
    published.push(source)
    visible.add(packageSpec(source))
    return ""
  })
  assert.equal(published.length, 2)
  assert.ok(published[0].includes(`${missingPlatform}-`))
  assert.equal(published[1], join(dist, "npm"))
})

it("recovers from a duplicate provenance entry and completes publishing", async () => {
  vi.useFakeTimers()
  const published = new Set()
  let provenanceFailed = false
  const publishing = publishPackages(async ([command, source]) => {
    if (command === "view") return published.has(source) ? `${version}\n` : ""
    if (!provenanceFailed) {
      provenanceFailed = true
      throw Object.assign(new Error("npm publish failed"), {
        stderr:
          "npm error code TLOG_CREATE_ENTRY_ERROR\nnpm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log",
      })
    }
    published.add(packageSpec(source))
    return ""
  })

  await vi.runAllTimersAsync()
  await publishing
  assert.ok(published.has(`${packageName}@${version}`))
  for (const platform of platforms)
    assert.ok(published.has(`${packageName}-${platform.name}@${version}`))
})

it.each(["successful upload", "staged-version conflict"])(
  "waits for registry visibility after a %s before publishing the launcher",
  async (outcome) => {
    vi.useFakeTimers()
    const published = new Set()
    const pendingSpec = `${packageName}-${platforms[0].name}@${version}`
    let pending = false
    let launcherPublished = false
    const publishing = publishPackages(async ([command, source]) => {
      if (command === "view") return published.has(source) ? `${version}\n` : ""
      const spec = packageSpec(source)
      if (spec === pendingSpec) {
        // The registry reserves this version on acceptance, before exposing it.
        if (pending) throw new Error("Cannot upload a reserved version again")
        pending = true
        if (outcome === "staged-version conflict")
          throw Object.assign(new Error("npm publish failed"), {
            stderr: `npm error 409 Conflict - Cannot publish over previously staged version "${version}".`,
          })
        return ""
      }
      if (source === join(dist, "npm")) {
        assert.ok(published.has(pendingSpec))
        launcherPublished = true
      }
      published.add(spec)
      return ""
    })

    await vi.advanceTimersByTimeAsync(20_000)
    assert.ok(pending)
    assert.equal(launcherPublished, false)
    published.add(pendingSpec)
    await vi.runAllTimersAsync()
    await publishing
    assert.equal(launcherPublished, true)
  }
)

it.each(["missing versions", "stalled registry reads"])(
  "keeps the launcher unpublished when staged packages remain unavailable with %s",
  async (outcome) => {
    vi.useFakeTimers()
    let launcherPublished = false
    const conflict = new Error("Cannot publish over previously staged version")
    // Just past the publish budget.
    const registryRecovery = Date.now() + 21 * 60_000
    const publishing = publishPackages(async ([command, source], options) => {
      if (command === "view") {
        if (outcome === "stalled registry reads") {
          // Model a slow registry that eventually recovers, even if the caller
          // forgets to bound reads. Recovery must not extend the publish budget.
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(30_000, options?.timeout ?? 30_000))
          )
          if (Date.now() >= registryRecovery) return `${version}\n`
          throw new Error("npm view terminated while waiting for the registry")
        }
        return ""
      }
      if (source === join(dist, "npm")) launcherPublished = true
      throw conflict
    })
    const rejected = assert.rejects(publishing, (error) => {
      assert.ok(error instanceof AggregateError)
      for (const failure of error.errors) {
        assert.match(failure.message, /still unavailable/)
        assert.equal(failure.cause, conflict)
      }
      return true
    })

    await Promise.all([vi.runAllTimersAsync(), rejected])
    assert.equal(launcherPublished, false)
  }
)

it("stops retrying persistent duplicate provenance failures", async () => {
  vi.useFakeTimers()
  let launcherPublished = false
  const failure = new Error(
    "TLOG_CREATE_ENTRY_ERROR: an equivalent entry already exists"
  )
  const publishing = publishPackages(async ([command, source]) => {
    if (command === "view") return ""
    if (source === join(dist, "npm")) launcherPublished = true
    throw failure
  })
  const rejected = assert.rejects(publishing, (error) => {
    assert.ok(error instanceof AggregateError)
    assert.ok(error.errors.every((reason) => reason === failure))
    return true
  })

  await vi.runAllTimersAsync()
  await rejected
  assert.equal(launcherPublished, false)
})
