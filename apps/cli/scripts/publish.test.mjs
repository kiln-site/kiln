import assert from "node:assert/strict"
import { afterEach, it, vi } from "vite-plus/test"

import { publishPackages } from "./publish.mjs"

afterEach(() => vi.useRealTimers())

it("leaves an already published bootstrap available without republishing", async () => {
  await publishPackages(async ([command]) => {
    if (command === "view") return "0.1.0\n"
    throw new Error("Cannot publish over an existing version")
  })
})

it("recovers from a duplicate provenance entry and completes publishing", async () => {
  vi.useFakeTimers()
  let visible = false
  let provenanceFailed = false
  const publishing = publishPackages(async ([command]) => {
    if (command === "view") return visible ? "0.1.0\n" : ""
    if (!provenanceFailed) {
      provenanceFailed = true
      throw new Error(
        "TLOG_CREATE_ENTRY_ERROR: an equivalent entry already exists"
      )
    }
    visible = true
    return ""
  })
  await vi.runAllTimersAsync()
  await publishing
  assert.ok(visible)
})

it.each(["successful upload", "staged-version conflict"])(
  "completes after registry processing following a %s",
  async (outcome) => {
    vi.useFakeTimers()
    let accepted = false
    let visible = false
    const publishing = publishPackages(async ([command]) => {
      if (command === "view") return visible ? "0.1.0\n" : ""
      if (accepted) throw new Error("Cannot upload a reserved version again")
      accepted = true
      if (outcome === "staged-version conflict")
        throw new Error("Cannot publish over previously staged version")
      return ""
    })
    await vi.advanceTimersByTimeAsync(20_000)
    assert.ok(accepted)
    visible = true
    await vi.runAllTimersAsync()
    await publishing
  }
)

it("reports failure when an accepted version stays unavailable", async () => {
  vi.useFakeTimers()
  const conflict = new Error("Cannot publish over previously staged version")
  const publishing = publishPackages(async ([command]) => {
    if (command === "view") return ""
    throw conflict
  })
  const rejected = assert.rejects(publishing, (error) => {
    assert.match(error.message, /still unavailable/u)
    assert.equal(error.cause, conflict)
    return true
  })
  await Promise.all([vi.runAllTimersAsync(), rejected])
})

it("stops retrying persistent duplicate provenance failures", async () => {
  vi.useFakeTimers()
  const failure = new Error(
    "TLOG_CREATE_ENTRY_ERROR: an equivalent entry already exists"
  )
  const publishing = publishPackages(async ([command]) => {
    if (command === "view") return ""
    throw failure
  })
  const rejected = assert.rejects(publishing, failure)
  await Promise.all([vi.runAllTimersAsync(), rejected])
})
