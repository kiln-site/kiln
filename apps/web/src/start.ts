import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start"

import { traceAppPromise } from "./effect/runtime"
import { requestSpanName } from "./observability/request-span"

const csrfMiddleware = createCsrfMiddleware({
  filter: (context) => context.handlerType === "serverFn",
})

// One trace per request; effects run while handling it become its children.
const tracingMiddleware = createMiddleware().server(
  ({ request, pathname, serverFnMeta, next }) =>
    traceAppPromise(
      requestSpanName(request.method, pathname, serverFnMeta),
      async (span) => {
        const result = await next()
        span.attribute("http.response.status_code", result.response.status)
        return result
      },
      { "http.request.method": request.method }
    )
)

export const startInstance = createStart(() => ({
  requestMiddleware: [tracingMiddleware, csrfMiddleware],
}))
