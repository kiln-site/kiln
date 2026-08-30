import * as React from "react"
import { QueryErrorResetBoundary } from "@tanstack/react-query"
import { ClientOnly } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

export function DataTableBoundary({
  children,
  fallback,
  resetKey,
}: {
  children: React.ReactNode
  fallback: React.ReactNode
  resetKey: string
}) {
  return (
    <ClientOnly fallback={fallback}>
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <DataTableErrorBoundary resetKey={resetKey} onReset={reset}>
            <React.Suspense fallback={fallback}>{children}</React.Suspense>
          </DataTableErrorBoundary>
        )}
      </QueryErrorResetBoundary>
    </ClientOnly>
  )
}

class DataTableErrorBoundary extends React.Component<
  {
    children: React.ReactNode
    onReset: () => void
    resetKey: string
  },
  { error: Error | null }
> {
  state = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }

  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.props.onReset()
      this.setState({ error: null })
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="grid h-64 place-items-center px-6 text-center">
        <div>
          <p className="text-sm font-semibold">Could not load this table</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Check your connection and try again.
          </p>
          <Button
            className="mt-4"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => {
              this.props.onReset()
              this.setState({ error: null })
            }}
          >
            Try again
          </Button>
        </div>
      </div>
    )
  }
}
