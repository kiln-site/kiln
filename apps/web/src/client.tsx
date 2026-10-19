import { scan } from "react-scan"

import { StrictMode, startTransition } from "react"
import {
  Await,
  RouterContextProvider,
  type AnyRouter,
} from "@tanstack/react-router"
import { hydrateStart } from "@tanstack/react-start/client"
import { hydrateRoot } from "react-dom/client"

import { AppRouterApplication } from "@/components/app-router-application"
import { startBrowserTelemetry } from "@/lib/browser-telemetry"
import { createRenderAudit } from "@/lib/render-audit"

startBrowserTelemetry()

if (import.meta.env.DEV && typeof window !== "undefined") {
  const { audit, onRender } = createRenderAudit()
  window.__hearthRenderAudit = audit
  scan({
    enabled: false,
    onRender,
    showToolbar: true,
  })
}

let hydrationPromise: Promise<AnyRouter> | undefined

function HearthStartClient() {
  hydrationPromise ??= hydrateStart()

  return (
    <Await promise={hydrationPromise}>
      {(router) => (
        <RouterContextProvider router={router}>
          <AppRouterApplication />
        </RouterContextProvider>
      )}
    </Await>
  )
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HearthStartClient />
    </StrictMode>
  )
})
