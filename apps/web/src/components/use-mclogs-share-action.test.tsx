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
