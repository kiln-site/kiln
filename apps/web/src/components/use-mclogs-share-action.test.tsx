import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test"

import { useMclogsShareAction } from "./use-mclogs-share-action"

const openedUrls: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
    open: (url: string) => openedUrls.push(url),
  })
})

afterEach(() => {
  openedUrls.length = 0
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function renderShare(action: () => Promise<string>) {
  let share: ReturnType<typeof useMclogsShareAction> | undefined
  function Harness() {
    share = useMclogsShareAction(action)
    return null
  }
  renderToStaticMarkup(<Harness />)
  if (!share) throw new Error("Share hook was not rendered")
  return share
}

function pointerLeave(pointerType: string) {
  return { pointerType } as React.PointerEvent<HTMLElement>
}

it("opens the copied upload on the second click without uploading again", async () => {
  const urls = ["https://mclo.gs/first", "https://mclo.gs/second"]
  const action = renderShare(async () => urls.shift()!)

  await action.share()
  expect(openedUrls).toEqual([])
  await action.share()
  expect(openedUrls).toEqual(["https://mclo.gs/first"])

  // Opening consumes the link; the next share creates a fresh upload.
  await action.share()
  await action.share()
  expect(openedUrls).toEqual([
    "https://mclo.gs/first",
    "https://mclo.gs/second",
  ])
})

it("does not start overlapping uploads while the first click is pending", async () => {
  let finishUpload!: (url: string) => void
  const upload = new Promise<string>((resolve) => {
    finishUpload = resolve
  })
  const urls = [upload, Promise.resolve("https://mclo.gs/duplicate")]
  const action = renderShare(() => urls.shift()!)

  const firstClick = action.share()
  await action.share()
  finishUpload("https://mclo.gs/first")
  await firstClick
  expect(openedUrls).toEqual([])

  await action.share()
  expect(openedUrls).toEqual(["https://mclo.gs/first"])
})

it("shares a fresh upload after the copied link expires", async () => {
  const urls = ["https://mclo.gs/expired", "https://mclo.gs/current"]
  const action = renderShare(async () => urls.shift()!)

  await action.share()
  await vi.runAllTimersAsync()
  await action.share()
  expect(openedUrls).toEqual([])
  await action.share()
  expect(openedUrls).toEqual(["https://mclo.gs/current"])
})

it("disarms on mouse leave and keeps the link available after a touch tap", async () => {
  const urls = ["https://mclo.gs/previous", "https://mclo.gs/current"]
  const action = renderShare(async () => urls.shift()!)

  await action.share()
  action.onPointerLeave(pointerLeave("mouse"))
  await action.share()
  expect(openedUrls).toEqual([])

  action.onPointerLeave(pointerLeave("touch"))
  await action.share()
  expect(openedUrls).toEqual(["https://mclo.gs/current"])
})

it("allows retrying a failed upload before opening the successful link", async () => {
  const action = renderShare(
    vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Upload failed"))
      .mockResolvedValue("https://mclo.gs/retried")
  )

  await action.share()
  await action.share()
  expect(openedUrls).toEqual([])
  await action.share()
  expect(openedUrls).toEqual(["https://mclo.gs/retried"])
})

it.each([
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd",
  "ftp://example.com/log",
  "//example.com/log",
  "not a URL",
])("does not open an unsafe share URL: %s", async (url) => {
  const action = renderShare(
    vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(url)
      .mockResolvedValue("https://mclo.gs/safe")
  )

  await action.share()
  await action.share()
  expect(openedUrls).toEqual([])
  await action.share()
  expect(openedUrls).toEqual(["https://mclo.gs/safe"])
})

it("does not arm a completed upload after the mouse leaves while pending", async () => {
  let finishUpload!: (url: string) => void
  const upload = new Promise<string>((resolve) => {
    finishUpload = resolve
  })
  const urls = [upload, Promise.resolve("https://mclo.gs/current")]
  const action = renderShare(() => urls.shift()!)

  const firstClick = action.share()
  action.onPointerLeave(pointerLeave("mouse"))
  finishUpload("https://mclo.gs/previous")
  await firstClick

  await action.share()
  expect(openedUrls).toEqual([])
  await action.share()
  expect(openedUrls).toEqual(["https://mclo.gs/current"])
})
