import { isNotFound, isRedirect } from "@tanstack/react-router"
import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start"

import { tapPromiseError } from "./effect/promise"
import {
  getRenderedAccount,
  isAccountChangedError,
  renderedAccountHeader,
} from "./lib/browser-accounts"
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
          (cause) => {
            // The browser hung up, as when it leaves a page mid-stream:
            // Node ends the request with a connection reset.
            if (request.signal.aborted && isConnectionReset(cause)) return
            reportRequestError(cause, name)
          }
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

// Hearth refuses calls from a tab that still renders an account the browser
// has switched away from; that tab reloads as the active account.
const renderedAccountMiddleware = createMiddleware({ type: "function" }).client(
  ({ next }) => {
    const account = getRenderedAccount()
    return tapPromiseError(
      () =>
        next(
          account === null
            ? undefined
            : { headers: { [renderedAccountHeader]: account } }
        ),
      (cause) => {
        if (isAccountChangedError(cause)) window.location.reload()
      }
    )
  }
)

function reportRequestError(cause: unknown, operation: string): void {
  // Redirects, not-found results, thrown responses, and calls from a tab that
  // has not yet followed an account switch are control flow.
  if (
    isRedirect(cause) ||
    isNotFound(cause) ||
    cause instanceof Response ||
    isAccountChangedError(cause)
  ) {
    return
  }
  reportAppError(cause, { operation })
}

function isConnectionReset(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    cause.code === "ECONNRESET"
  )
}

export const startInstance = createStart(() => ({
  requestMiddleware: [tracingMiddleware, csrfMiddleware],
  functionMiddleware: [renderedAccountMiddleware, errorMiddleware],
}))
