import * as React from "react"

import { Walkthrough } from "~/components/walkthroughs/walkthrough"

// Each walkthrough a page can show with ```walkthrough <name>```. Its code
// loads only on the pages that use it.
const walkthroughs: Record<
  string,
  React.LazyExoticComponent<() => React.ReactNode>
> = {
  "add-relay": React.lazy(() =>
    import("~/components/walkthroughs/add-relay").then((module) => ({
      default: () => <Walkthrough scene={module.addRelay} />,
    }))
  ),
}

export function WalkthroughNamed({ name }: { name: string }) {
  const Named = walkthroughs[name]
  if (!Named) return null
  return (
    <React.Suspense fallback={null}>
      <Named />
    </React.Suspense>
  )
}
