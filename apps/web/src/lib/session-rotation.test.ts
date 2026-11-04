import { afterEach, describe, expect, it, vi } from "vite-plus/test"

// Each tab has its own copy of the module, joined by the BroadcastChannel.
async function openTab() {
  vi.resetModules()
  return import("./session-rotation")
}

function trackedStream() {
  const stream = {
    close: vi.fn(() => {
      stream.opened = false
    }),
    open: vi.fn(() => {
      stream.opened = true
    }),
    opened: false,
  }
  return stream
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (cause: unknown) => void = () => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, reject, resolve }
}

const until = (condition: () => boolean) =>
  vi.waitFor(() => expect(condition()).toBe(true))

describe("session rotation", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps a tab's streams closed until the new cookie has arrived", async () => {
    const tab = await openTab()
    const stream = trackedStream()
    tab.holdStreamAcrossSessionRotation(stream)
    expect(stream.opened).toBe(true)

    const response = deferred<string>()
    const rotation = tab.rotateSession(() => response.promise)
    expect(stream.opened).toBe(false)
    expect(tab.isSessionRotating()).toBe(true)

    response.resolve("rotated")
    await expect(rotation).resolves.toBe("rotated")
    expect(stream.opened).toBe(true)
    expect(tab.isSessionRotating()).toBe(false)
  })

  it("reopens streams when the call fails, since the session is unchanged", async () => {
    const tab = await openTab()
    const stream = trackedStream()
    tab.holdStreamAcrossSessionRotation(stream)

    await expect(
      tab.rotateSession(() => Promise.reject(new Error("wrong code")))
    ).rejects.toThrow("wrong code")

    expect(stream.opened).toBe(true)
  })

  it("holds other tabs too, because they share the cookie", async () => {
    const acting = await openTab()
    const other = await openTab()
    const stream = trackedStream()
    other.holdStreamAcrossSessionRotation(stream)
    acting.holdStreamAcrossSessionRotation(trackedStream())

    const response = deferred<void>()
    const rotation = acting.rotateSession(() => response.promise)
    await until(() => !stream.opened)
    expect(other.isSessionRotating()).toBe(true)

    response.resolve()
    await rotation
    await until(() => stream.opened)
    expect(other.isSessionRotating()).toBe(false)
  })

  it("stays closed until the last overlapping rotation ends", async () => {
    const tab = await openTab()
    const stream = trackedStream()
    tab.holdStreamAcrossSessionRotation(stream)

    const first = deferred<void>()
    const second = deferred<void>()
    const rotations = [
      tab.rotateSession(() => first.promise),
      tab.rotateSession(() => second.promise),
    ]

    first.resolve()
    await rotations[0]
    expect(stream.opened).toBe(false)

    second.resolve()
    await rotations[1]
    expect(stream.opened).toBe(true)
    expect(stream.open).toHaveBeenCalledTimes(2)
  })

  it("recovers when the rotating tab disappears mid-rotation", async () => {
    const acting = await openTab()
    const other = await openTab()
    const stream = trackedStream()
    other.holdStreamAcrossSessionRotation(stream)
    acting.holdStreamAcrossSessionRotation(trackedStream())

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    void acting.rotateSession(() => new Promise(() => {}))
    await vi.waitFor(() => expect(stream.opened).toBe(false), {
      interval: 1,
    })

    vi.advanceTimersByTime(15_000)
    expect(stream.opened).toBe(true)
  })

  it("opens a stream that starts during a rotation once it ends", async () => {
    const tab = await openTab()
    const response = deferred<void>()
    const rotation = tab.rotateSession(() => response.promise)

    const stream = trackedStream()
    tab.holdStreamAcrossSessionRotation(stream)
    expect(stream.open).not.toHaveBeenCalled()

    response.resolve()
    await rotation
    expect(stream.opened).toBe(true)
  })
})
