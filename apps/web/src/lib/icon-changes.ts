import type { QueryClient } from "@tanstack/react-query"
import { Effect } from "effect"

import { promiseEffect } from "@/effect/promise"
import { runBrowserEffect } from "@/lib/browser-telemetry"
import { iconSubjectKey, type IconIndex, type IconSubject } from "@/lib/icons"
import { iconIndexQueryOptions, queryKeys } from "@/lib/query-options"

// Changing an icon answers the digest it shows next, so the page shows the
// change at once instead of asking for the index again. Realtime tells
// everyone else.

const changeIconEffect = Effect.fn("Icons.change")(function* (
  queryClient: QueryClient,
  subject: IconSubject,
  change: () => Promise<{ readonly digest: string | null }>
) {
  yield* Effect.annotateCurrentSpan("kiln.icon.kind", subject.kind)
  const { digest } = yield* promiseEffect(change)
  const { queryKey } = iconIndexQueryOptions()
  // A refetch that started before the change would put the old icon back.
  yield* promiseEffect(() => queryClient.cancelQueries({ queryKey }))
  const key = iconSubjectKey(subject)
  queryClient.setQueryData(queryKey, (index: IconIndex | undefined) => {
    if (!index || (index.digests[key] ?? null) === digest) return index
    const { [key]: _previous, ...digests } = index.digests
    return { ...index, digests: digest ? { ...digests, [key]: digest } : digests }
  })
  yield* Effect.annotateCurrentSpan("kiln.icon.shown", digest !== null)
  // Then the whole index again, for any other change the cancel set aside.
  void queryClient.invalidateQueries({ queryKey })
  void queryClient.invalidateQueries({
    queryKey: queryKeys.icons.detail(key),
  })
})

/** Runs a change to a subject's icon and shows its result right away. */
export function changeIcon(
  queryClient: QueryClient,
  subject: IconSubject,
  change: () => Promise<{ readonly digest: string | null }>
): Promise<void> {
  return runBrowserEffect(changeIconEffect(queryClient, subject, change))
}
