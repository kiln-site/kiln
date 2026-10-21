import * as React from "react"

// Demos load only in the browser, after the page paints, so their code and
// data never hold up the first view.
export function ClientDemo({
  children,
  fallback,
}: {
  children: React.ReactNode
  fallback: React.ReactNode
}) {
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => setMounted(true), [])

  return (
    <div>
      {mounted ? (
        <React.Suspense fallback={fallback}>{children}</React.Suspense>
      ) : (
        fallback
      )}
    </div>
  )
}
