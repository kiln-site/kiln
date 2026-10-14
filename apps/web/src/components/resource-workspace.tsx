import * as React from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

// Pieces shared by the database, app, and Relay workspaces: each resolves its
// resource from the route, then renders the same frame around its pages.

export type ResourceWorkspaceQuery<T> =
  | { status: "pending" }
  | { status: "error" }
  | { status: "missing" }
  | { status: "found"; value: T }

export function useWorkspaceRouteParam(
  name: "appId" | "databaseId" | "relayId"
): string | undefined {
  return useRouterState({
    select: (state) => {
      const params = state.matches.at(-1)?.params as
        | Record<string, unknown>
        | undefined
      const value = params?.[name]
      return typeof value === "string" ? value : undefined
    },
  })
}

export function useResourceWorkspaceQuery<T>(query: {
  data: T | null | undefined
  isError: boolean
  isPending: boolean
}): ResourceWorkspaceQuery<T> {
  const { data, isError, isPending } = query
  // Structural sharing keeps `data` stable while the resource is unchanged,
  // so this object only changes when its content does.
  return React.useMemo(() => {
    if (data) return { status: "found", value: data }
    if (isPending) return { status: "pending" }
    if (isError) return { status: "error" }
    return { status: "missing" }
  }, [data, isError, isPending])
}

export function ResourceWorkspaceBoundary<T>({
  children,
  context,
  icon,
  list,
  noun,
  workspace,
}: {
  children: React.ReactNode
  context: React.Context<T | null>
  icon: React.ReactNode
  // Where the person goes from a missing resource.
  list: {
    label: string
    to: "/infra/apps" | "/infra/databases" | "/infra/relays"
  }
  // Singular and plural, lowercase: `{ one: "app", other: "apps" }`.
  noun: { one: string; other: string }
  workspace: ResourceWorkspaceQuery<T>
}) {
  if (workspace.status === "found") {
    return (
      <context.Provider value={workspace.value}>{children}</context.Provider>
    )
  }
  if (workspace.status === "pending") {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-card">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  const plural = noun.other.charAt(0).toUpperCase() + noun.other.slice(1)
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground [&_svg]:size-5">
          {icon}
        </div>
        <p className="text-sm font-semibold">
          {workspace.status === "error"
            ? `${plural} could not be loaded`
            : `This ${noun.one} is no longer available`}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {workspace.status === "error"
            ? `Hearth could not reach the ${noun.one} inventory. Try again shortly.`
            : "It may have been deleted, or your access to it changed."}
        </p>
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link to={list.to}>{list.label}</Link>
        </Button>
      </div>
    </div>
  )
}

// The page's title in the workspace header, from the destination its path
// names (`/<kind>/<id>/<destination>`).
export function WorkspaceRouteTitle({
  destinations,
  fallback,
  notFoundRouteId,
}: {
  destinations: ReadonlyArray<{ label: string; to: string }>
  fallback: string
  notFoundRouteId: string
}) {
  const title = useRouterState({
    select: (state) => {
      if (
        state.matches.at(-1)?.routeId === notFoundRouteId ||
        state.matches.some(
          (match) => match.status === "notFound" || match._notFound
        )
      ) {
        return "Not found"
      }
      const segment = state.location.pathname.split("/")[3]
      return (
        destinations.find(
          (destination) => destination.to.split("/")[3] === segment
        )?.label ?? fallback
      )
    },
  })
  return <>{title}</>
}
