import { isServer } from "@tanstack/react-query"
import type { QueryFunction, QueryKey, SkipToken } from "@tanstack/react-query"
import { createServerOnlyFn } from "@tanstack/react-start"
import { Duration, Effect, Predicate } from "effect"

import { RenderReadError } from "@/effect/errors"
import { promiseEffect } from "@/effect/promise"

// A Relay request gives up well before this on its own, so a read has ended
// before the browser retries it. This only guarantees one settles inside the
// 60 s Start keeps streaming data once a page has rendered.
const renderReadBudget = Duration.seconds(40)

const runRenderRead = createServerOnlyFn(
  async (name: string, read: () => Promise<unknown>): Promise<unknown> => {
    const { runAppEffect } = await import("@/effect/runtime")
    return runAppEffect(
      "Page.renderRead",
      Effect.annotateCurrentSpan("kiln.page.read", name).pipe(
        Effect.andThen(promiseEffect(read)),
        Effect.timeoutOrElse({
          duration: renderReadBudget,
          orElse: () =>
            Effect.fail(
              new RenderReadError({
                message: "The Relay didn't answer in time",
              })
            ),
        }),
        // The same message the browser gets when it makes the read itself.
        Effect.mapError((cause) =>
          cause instanceof RenderReadError
            ? cause
            : new RenderReadError({
                message:
                  Predicate.isError(cause) && cause.message
                    ? cause.message
                    : "Could not read this",
              })
        )
      )
    )
  }
)

/**
 * A query a route's loader starts while Hearth renders the page. TanStack
 * Query's router integration streams it into the page as it settles, so the
 * browser starts with the result instead of asking for it after hydrating.
 *
 * On the server the read is bounded: a streamed read that never settles
 * would leave the browser's query pending for good. It isn't retried there
 * either; a read that fails is retried by the browser as soon as it hydrates
 * (see `createAppQueryClient`), or when its query mounts. An infinite query
 * already mounted when it fails is the exception: TanStack retries it with
 * the options it hydrated with, which have no query function, so it keeps
 * the error until retried by hand. In the browser the options are unchanged.
 */
export function renderRead<
  TOptions extends {
    // A query's own function types its data, key, and any page param.
    queryFn?:
      | QueryFunction<any, any, never>
      | QueryFunction<any, any, any>
      | SkipToken
  },
>(name: string, options: TOptions): TOptions {
  const { queryFn } = options
  if (!isServer || typeof queryFn !== "function") return options
  const bounded: QueryFunction<unknown, QueryKey, unknown> = (context) =>
    runRenderRead(name, () => Promise.resolve(queryFn(context)))
  return { ...options, queryFn: bounded, retry: false }
}
