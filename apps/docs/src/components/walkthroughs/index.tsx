import * as React from "react"

// Each walkthrough a page can show with ```walkthrough <name>```. The player
// and the scene load only on the pages that use them.
const walkthroughs: Record<
  string,
  React.LazyExoticComponent<() => React.ReactNode>
> = {
  "add-relay": React.lazy(async () => {
    const [{ Walkthrough }, { addRelay }] = await Promise.all([
      import("~/components/walkthroughs/walkthrough"),
      import("~/components/walkthroughs/add-relay"),
    ])
    return { default: () => <Walkthrough scene={addRelay} /> }
  }),
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
