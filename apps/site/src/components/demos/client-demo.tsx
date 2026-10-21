import * as React from "react"

// Demos load only in the browser, after the page paints, so their code and
// data never hold up the first view. Ones further down the page wait until
// they're about to scroll into view.
export function ClientDemo({
  children,
  fallback,
  whenVisible = false,
}: {
  children: React.ReactNode
  fallback: React.ReactNode
  whenVisible?: boolean
}) {
  const [mounted, setMounted] = React.useState(false)
  const frameRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const frame = frameRef.current
    if (!whenVisible || !frame) {
      setMounted(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        observer.disconnect()
        setMounted(true)
      },
      { rootMargin: "600px 0px" }
    )
    observer.observe(frame)
    return () => observer.disconnect()
  }, [whenVisible])

  return (
    <div ref={frameRef} className="h-full">
      {mounted ? (
        <React.Suspense fallback={fallback}>{children}</React.Suspense>
      ) : (
        fallback
      )}
    </div>
  )
}
