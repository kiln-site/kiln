import { isNotFound, isRedirect } from "@tanstack/react-router"
import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start"

import { tapPromiseError } from "./effect/promise"
import { reportAppError, traceAppPromise } from "./effect/runtime"
import { requestSpanName } from "./observability/request-span"

const csrfMiddleware = createCsrfMiddleware({
  filter: (context) => context.handlerType === "serverFn",
})

// One trace per request; effects run while handling it become its children.
// Server function failures are reported by errorMiddleware, because TanStack
// serializes them into the response before they reach this middleware.
const tracingMiddleware = createMiddleware().server(
  ({ request, pathname, serverFnMeta, next }) => {
    const name = requestSpanName(request.method, pathname, serverFnMeta)
    return traceAppPromise(
      name,
      async (span) => {
        const result = await tapPromiseError(
          async () => next(),
          (cause) => reportRequestError(cause, name)
        )
        span.attribute("http.response.status_code", result.response.status)
        return result
      },
      { "http.request.method": request.method }
    )
  }
)

const errorMiddleware = createMiddleware({ type: "function" }).server(
  ({ method, serverFnMeta, next }) =>
    tapPromiseError(next, (cause) =>
      reportRequestError(cause, requestSpanName(method, "", serverFnMeta))
    )
)

function reportRequestError(cause: unknown, operation: string): void {
  // Redirects, not-found results, and thrown responses are control flow.
  if (isRedirect(cause) || isNotFound(cause) || cause instanceof Response) {
    return
  }
  reportAppError(cause, { operation })
}

export const startInstance = createStart(() => ({
  requestMiddleware: [tracingMiddleware, csrfMiddleware],
  functionMiddleware: [errorMiddleware],
}))
