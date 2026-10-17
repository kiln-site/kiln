import {
  RouterContextProvider,
  type AnyRouter,
} from "@tanstack/react-router"
import {
  defineHandlerCallback,
  renderRouterToStream,
} from "@tanstack/react-router/ssr/server"

import { AppRouterApplication } from "@/components/app-router-application"
import { serverTimingHeader } from "@/lib/server-timing"

function HearthStartServer({ router }: { router: AnyRouter }) {
  return (
    <RouterContextProvider router={router}>
      <AppRouterApplication />
    </RouterContextProvider>
  )
}

export const hearthStreamHandler = defineHandlerCallback(
  ({ request, router, responseHeaders }) => {
    const timing = serverTimingHeader(router.options.context.queryClient)
    if (timing) responseHeaders.set("Server-Timing", timing)
    return renderRouterToStream({
      request,
      router,
      responseHeaders,
      children: <HearthStartServer router={router} />,
    })
  }
)
