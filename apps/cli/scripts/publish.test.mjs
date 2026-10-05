import assert from "node:assert/strict"
import { join } from "node:path"
import { it } from "vite-plus/test"

import { dist, packageName, platforms } from "./distribution.mjs"
import { publishPackages } from "./publish.mjs"

it("starts every native upload concurrently and publishes the launcher last", async () => {
  const started = Promise.withResolvers()
  const uploads = []
  let launcherPublished = false
  const publishing = publishPackages(async ([command, source]) => {
    if (command === "view") return ""
    if (source === join(dist, "npm")) {
      assert.ok(uploads.every((upload) => upload.finished))
      launcherPublished = true
      return ""
    }
    const pending = Promise.withResolvers()
    const upload = { ...pending, finished: false }
    uploads.push(upload)
    if (uploads.length === platforms.length) started.resolve()
    await upload.promise
    upload.finished = true
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
  let nativeUploads = 0
  let finished = false
  let launcherPublished = false
  const publishing = publishPackages(async ([command, source]) => {
    if (command === "view") throw new Error("version not published")
    if (source === join(dist, "npm")) launcherPublished = true
    nativeUploads += 1
    if (nativeUploads === platforms.length) started.resolve()
    if (nativeUploads === 1) throw failure
    await remaining.promise
    finished = true
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
  await publishPackages(async ([command, source]) => {
    if (command === "view") {
      if (source.startsWith(`${packageName}-${missingPlatform}@`)) return ""
      if (source.startsWith(`${packageName}@`)) return ""
      return "0.1.0-nightly.20261005.84700\n"
    }
    published.push(source)
    return ""
  })
  assert.equal(published.length, 2)
  assert.ok(published[0].includes(`${missingPlatform}-`))
  assert.equal(published[1], join(dist, "npm"))
})
