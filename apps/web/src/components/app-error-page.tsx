import * as React from "react"
import * as Sentry from "@sentry/tanstackstart-react"
import { Link, useRouter, useRouterState } from "@tanstack/react-router"
import type { AnyRouter } from "@tanstack/react-router"
import { ArrowLeft, RefreshCw, TriangleAlert } from "lucide-react"
import { createPortal } from "react-dom"

import { Button } from "@workspace/ui/components/button"

import { HearthMark } from "@/components/hearth-mark"

const reportedErrors = new WeakSet<Error>()
const notFoundStatus = {
  code: "404",
  eyebrow: "Unknown route",
  title: "There's nothing firing here.",
  description: "We can't find the page you're looking for",
}

interface AppErrorPageProps {
  error: Error
  reset: () => void
}

export function AppErrorPage({ error, reset }: AppErrorPageProps) {
  React.useEffect(() => {
    if (reportedErrors.has(error)) return
    reportedErrors.add(error)
    Sentry.captureException(error)
  }, [error])

  return (
    <StatusPage
      code="500"
      eyebrow="Unexpected application fault"
      title="Your Kiln ran out of fuel"
      description="Hearth could not finish loading this view"
      actions={
        <>
          <Button
            onClick={() => {
              reset()
              window.location.reload()
            }}
          >
            <RefreshCw /> Try again
          </Button>
          <Button variant="outline" asChild>
            <a href="/">
              <ArrowLeft /> Return to Kiln
            </a>
          </Button>
        </>
      }
      detail={import.meta.env.DEV ? error.message : undefined}
    />
  )
}

export function AppRouterErrorBoundary({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  return (
    <AppRouterErrorBoundaryImpl router={router}>
      {children}
    </AppRouterErrorBoundaryImpl>
  )
}

class AppRouterErrorBoundaryImpl extends React.Component<
  { children: React.ReactNode; router: AnyRouter },
  { error: Error | null }
> {
  state = { error: null }
  unsubscribeFromNavigation: (() => void) | null = null

  static getDerivedStateFromError(error: unknown) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }

  componentDidMount() {
    this.unsubscribeFromNavigation = this.props.router.subscribe(
      "onBeforeNavigate",
      () => {
        if (this.state.error) this.setState({ error: null })
      }
    )
  }

  componentWillUnmount() {
    this.unsubscribeFromNavigation?.()
  }

  render() {
    return this.state.error ? (
      <AppErrorPage
        error={this.state.error}
        reset={() => this.setState({ error: null })}
      />
    ) : (
      this.props.children
    )
  }
}

export function AppNotFoundPage() {
  const routeContext = useRouterState({
    select: (state) => {
      const match = state.matches.at(-1)
      const serverId =
        match?.routeId === "/_app/server/$serverId/$" &&
        "serverId" in match.params &&
        typeof match.params.serverId === "string"
          ? match.params.serverId
          : null

      return {
        pathname: (state.resolvedLocation ?? state.location).pathname,
        serverId,
        usesAppFrame: state.matches.some(
          (routeMatch) => routeMatch.routeId === "/_app"
        ),
      }
    },
  })
  const actions = routeContext.serverId ? (
    <Button asChild>
      <Link
        to="/server/$serverId/console"
        params={{ serverId: routeContext.serverId }}
        preload="render"
      >
        <ArrowLeft /> Return to Console
      </Link>
    </Button>
  ) : (
    <Button asChild>
      <Link to="/">
        <ArrowLeft /> Return to Kiln
      </Link>
    </Button>
  )

  return routeContext.usesAppFrame ? (
    <div
      data-slot="not-found-route"
      className="relative grid min-h-0 min-w-0 flex-1 place-items-center overflow-x-hidden overflow-y-auto bg-background/55 px-3 py-4 sm:px-5 sm:py-8"
    >
      <StatusBackdrop />
      <StatusPanel
        {...notFoundStatus}
        actions={actions}
        route={routeContext.pathname}
      />
    </div>
  ) : (
    <StatusPage
      {...notFoundStatus}
      actions={actions}
      route={routeContext.pathname}
    />
  )
}

function StatusPage({
  code,
  eyebrow,
  title,
  description,
  actions,
  detail,
  route,
}: {
  code: string
  eyebrow: string
  title: string
  description: string
  actions: React.ReactNode
  detail?: string
  route?: string
}) {
  const [portalTarget, setPortalTarget] = React.useState<HTMLElement | null>(
    null
  )
  React.useEffect(() => setPortalTarget(document.body), [])

  const page = (
    <main className="fixed inset-0 z-50 grid min-h-dvh place-items-center overflow-x-hidden overflow-y-auto bg-background px-3 py-4 sm:px-5 sm:py-10">
      <StatusBackdrop />
      <StatusPanel
        code={code}
        eyebrow={eyebrow}
        title={title}
        description={description}
        actions={actions}
        detail={detail}
        route={route}
      />
    </main>
  )

  return portalTarget ? createPortal(page, portalTarget) : page
}

function StatusBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="absolute top-1/2 left-1/2 h-[38rem] w-[38rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/4 blur-3xl" />
      <div className="absolute inset-x-0 top-1/2 border-t border-border/35" />
      <div className="absolute inset-y-0 left-1/2 border-l border-border/35" />
    </div>
  )
}

function StatusPanel({
  code,
  eyebrow,
  title,
  description,
  actions,
  detail,
  route,
}: {
  code: string
  eyebrow: string
  title: string
  description: string
  actions: React.ReactNode
  detail?: string
  route?: string
}) {
  return (
    <section className="relative w-full max-w-2xl min-w-0 border border-border/80 bg-card/80 shadow-2xl shadow-black/25 backdrop-blur-sm">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 border-b border-border/70 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:px-5">
        <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-3">
          <HearthMark className="size-7" />
          <span className="truncate font-heading text-sm font-semibold">
            Kiln
          </span>
        </div>
        <div className="type-technical-label col-span-2 row-start-2 flex items-center gap-2 justify-self-center text-primary sm:col-span-1 sm:col-start-2 sm:row-start-1">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="text-center">{eyebrow}</span>
        </div>
        <span className="type-technical-label col-start-2 row-start-1 justify-self-end whitespace-nowrap text-destructive sm:col-start-3">
          Fault / {code}
        </span>
      </header>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_8rem]">
        <div className="min-w-0 p-5 sm:p-7 lg:p-9">
          <h1 className="max-w-md font-heading text-2xl font-semibold tracking-[-0.045em] text-balance sm:text-3xl lg:text-4xl">
            {title}
          </h1>
          <p className="mt-4 max-w-md text-sm leading-6 text-muted-foreground">
            {description}
          </p>
          {route ? (
            <div className="mt-5 min-w-0 overflow-hidden border border-border/70 bg-background/55 px-3 py-2.5">
              <div className="type-technical-label text-muted-foreground">
                Requested route
              </div>
              <div
                role="region"
                aria-label="Requested route"
                tabIndex={0}
                className="mt-1.5 max-w-full [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] overflow-x-auto pb-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <code className="block w-max min-w-full font-mono text-xs leading-5 whitespace-nowrap text-foreground">
                  {route}
                </code>
              </div>
            </div>
          ) : null}
          {detail ? (
            <pre className="type-code mt-5 max-h-32 overflow-auto border border-destructive/20 bg-destructive/5 p-3 whitespace-pre-wrap text-destructive">
              {detail}
            </pre>
          ) : null}
          <div className="mt-6 flex flex-col gap-2 sm:flex-row [&>*]:w-full sm:[&>*]:w-auto">
            {actions}
          </div>
        </div>
        <div className="relative hidden overflow-hidden border-l border-border/70 bg-muted/10 lg:block">
          <span className="absolute -right-3 bottom-0 font-mono text-[7.5rem] leading-[0.72] font-bold tracking-[-0.12em] text-foreground/3 [writing-mode:vertical-rl]">
            {code}
          </span>
          <div className="absolute top-5 left-1/2 h-24 border-l border-primary/30" />
          <span className="absolute top-4 left-1/2 size-1.5 -translate-x-1/2 bg-primary shadow-[0_0_16px_var(--primary)]" />
        </div>
      </div>

      <footer className="type-technical-label border-t border-border/70 bg-muted/10 px-4 py-3 text-center text-muted-foreground sm:px-5 sm:text-left">
        Hearth interface / protected recovery state
      </footer>
    </section>
  )
}
