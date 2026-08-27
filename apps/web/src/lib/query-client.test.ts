import { describe, expect, it } from "vite-plus/test"
import type { QueryClient } from "@tanstack/react-query"

import { createAppClients, registerDbClientSsrCleanup } from "./query-client"
import type { RouterSsrCleanupLifecycle } from "./query-client"

describe("app data clients", () => {
  it("isolates Query and DB state by router request or browser session", async () => {
    const first = createAppClients()
    const second = createAppClients()

    expect(first.queryClient).not.toBe(second.queryClient)
    expect(first.dbClient).not.toBe(second.dbClient)
    expect(first.dbClient.requireDependency<QueryClient>("queryClient")).toBe(
      first.queryClient
    )
    expect(second.dbClient.requireDependency<QueryClient>("queryClient")).toBe(
      second.queryClient
    )

    await Promise.all([first.dbClient.cleanup(), second.dbClient.cleanup()])
  })

  it("cleans DB state up at the end of an SSR request", async () => {
    let cleaned = false
    let cleanup: (() => void) | undefined
    const router: RouterSsrCleanupLifecycle = { isServer: true }

    registerDbClientSsrCleanup(router, {
      cleanup: async () => {
        cleaned = true
      },
    })
    router.serverSsrLifecycle?.onServerSsrAttach?.[0]?.({
      onCleanup: (listener: () => void) => {
        cleanup = listener
      },
    } as NonNullable<RouterSsrCleanupLifecycle["serverSsr"]>)

    cleanup?.()
    await Promise.resolve()
    expect(cleaned).toBe(true)
  })

  it("does not register SSR cleanup in the browser", () => {
    const router: RouterSsrCleanupLifecycle = { isServer: false }

    registerDbClientSsrCleanup(router, { cleanup: async () => undefined })

    expect(router).not.toHaveProperty("serverSsrLifecycle")
  })
})
