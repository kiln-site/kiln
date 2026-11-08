import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { primaryWebRoute } from "@workspace/contracts"
import type { RelayAppWebRoute } from "@workspace/contracts"
import { Cable, LoaderCircle, Rocket } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import { useAppContainerSelection } from "@/components/app/app-container-selection"
import {
  appRelayAvailable,
  appStatusPresentation,
  showAppOperationError,
  type App,
} from "@/components/app/app-presentation"
import { InfoSection, InfoSectionLink } from "@/components/info-page"
import { StatusIndicator } from "@/components/status-indicator"
import {
  appConfigQueryOptions,
  appDeploymentSummaryQueryOptions,
  appWebRoutesQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import { deployApp } from "@/server/apps"
import { useAppDeployState } from "@/components/app/use-app-deploy-state"

// The app's details on its Info page, one section per concern, each with
// the actions that change it. What runs where is tagged with the service
// whose container serves it.

// Whether the app deploys a Compose file, its own or one in a repository.
// Read from the cached config and deployment summary, so it doesn't wait on
// the containers.
export function useAppRunsCompose(app: App): boolean {
  const { data: sourceType } = useQuery({
    ...appConfigQueryOptions(app.relayId, app.id),
    select: ({ config }) => config.sourceType,
  })
  const { data: build } = useQuery({
    ...appDeploymentSummaryQueryOptions(app.relayId, app.id),
    enabled: sourceType === "github",
    select: (summary) => summary.source?.build ?? null,
  })
  return (
    sourceType === "compose" || (sourceType === "github" && build === "compose")
  )
}

// How the app is reached: the domains Traefik serves, each tagged with the
// service it reaches. The Network page adds and edits them.
export function AppWebRouteSettings({
  app,
  canManage,
}: {
  app: App
  canManage: boolean
}) {
  const state = useQuery(appWebRoutesQueryOptions(app.relayId, app.id))
  const routes = state.data?.routes ?? []
  const empty = !state.data || routes.length === 0
  const primary = primaryWebRoute(routes)
  // The primary domain leads.
  const orderedRoutes = primary
    ? [primary, ...routes.filter((route) => route !== primary)]
    : routes

  return (
    <InfoSection
      icon={<Cable />}
      title="Connection"
      status={
        state.data && routes.length > 0 ? (
          <StatusIndicator status={webRouteStatus(state.data)} />
        ) : null
      }
      action={
        <>
          {canManage && state.data?.status === "pending_restart" ? (
            <DeployToApplyButton app={app} />
          ) : null}
          <InfoSectionLink to="/app/$appId/network" params={{ appId: app.id }}>
            {canManage ? "Manage" : "Network"}
          </InfoSectionLink>
        </>
      }
      content={empty}
    >
      {state.isPending ? (
        <div className="grid h-10 place-items-center">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : state.isError ? (
        <p className="text-xs text-destructive">{state.error.message}</p>
      ) : routes.length === 0 ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          No domains point at this app. Add one on the Network page to serve a
          service over HTTPS.
        </p>
      ) : (
        orderedRoutes.map((route) => (
          <WebRouteFact
            key={route.id}
            app={app}
            primary={route === primary}
            route={route}
          />
        ))
      )}
    </InfoSection>
  )
}

// A route reads like a fact: its address on the left, opening it, and the
// service and port it reaches on the right.
const WebRouteFact = React.memo(function WebRouteFact({
  app,
  primary,
  route,
}: {
  app: App
  primary: boolean
  route: RelayAppWebRoute
}) {
  const address = `${route.hostname}${route.path ?? ""}`
  return (
    <div className="flex min-h-10 items-center gap-3 border-b border-border/60 py-1.5 text-[0.8125rem] last:border-b-0">
      <dt className="flex min-w-0 flex-1 items-baseline gap-2">
        <a
          className="truncate font-medium transition-colors hover:text-primary-ink"
          href={`https://${address}`}
          rel="noreferrer"
          target="_blank"
          title={address}
        >
          {address}
        </a>
        <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">
          {[
            primary ? "Primary" : null,
            route.name || null,
            route.path && route.stripPrefix ? "strips path" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </dt>
      <dd className="flex min-w-0 shrink-0 items-center justify-end">
        {route.redirect ? (
          <span className="max-w-56 truncate font-mono text-xs text-muted-foreground">
            → {route.redirect.to}
          </span>
        ) : (
          <ServiceTarget
            app={app}
            port={String(route.targetPort)}
            service={route.service}
          />
        )}
      </dd>
    </div>
  )
})

export function DeployToApplyButton({ app }: { app: App }) {
  const queryClient = useQueryClient()
  const deploy = useMutation({
    mutationFn: () =>
      deployApp({ data: { appId: app.id, relayId: app.relayId } }),
    onSuccess: () => {
      showToast({ message: "Deploy queued", type: "success" })
      return queryClient.invalidateQueries({ queryKey: queryKeys.apps.all })
    },
    onError: (error) => showAppOperationError("Deploy failed", error),
  })
  // Asked during a build, it applies once that ends; once asked, it waits.
  const queued = useAppDeployState(app.id)?.queuedId != null
  const deploying = deploy.isPending || queued
  return (
    <Button
      type="button"
      size="sm"
      disabled={deploying}
      onClick={() => deploy.mutate()}
    >
      {deploying ? <LoaderCircle className="animate-spin" /> : <Rocket />}
      {queued ? "Deploy queued" : "Deploy to apply"}
    </Button>
  )
}

// "→ web :80": the service whose container takes the traffic, then its
// port.
function ServiceTarget({
  app,
  port,
  service,
}: {
  app: App
  port: string
  service: string
}) {
  return (
    <span className="flex items-center gap-1.5 font-mono text-xs">
      <span aria-hidden="true" className="text-muted-foreground">
        →
      </span>
      <ServiceTag app={app} service={service} />
      <span className="text-muted-foreground">:{port}</span>
    </span>
  )
}

// A service, with whether its container runs. It shows that container in
// the Container section.
export function ServiceTag({ app, service }: { app: App; service: string }) {
  const selection = useAppContainerSelection()
  const container = app.containers.find(
    (candidate) => candidate.service === service
  )
  const available = appRelayAvailable(app)
  const state = !available
    ? appStatusPresentation(app).label
    : !container
      ? "Not deployed"
      : container.running
        ? "Running"
        : "Stopped"
  return (
    <button
      type="button"
      title={`${service}: ${state}. Show its container.`}
      className="inline-flex items-center gap-1.5 border bg-muted/30 px-1.5 py-0.5 font-mono text-[11px] text-foreground transition-colors outline-none hover:border-primary/60 hover:text-primary-ink focus-visible:border-primary"
      onClick={() => selection?.select({ service })}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          !available || !container
            ? "bg-muted-foreground/40"
            : container.running
              ? "bg-emerald-400"
              : "bg-amber-400"
        )}
      />
      {service}
    </button>
  )
}

function webRouteStatus(state: {
  message: string
  status: string
}): React.ComponentProps<typeof StatusIndicator>["status"] {
  if (state.status === "ready")
    return { detail: state.message, label: "Live", tone: "success" }
  if (state.status === "pending_restart")
    return { detail: state.message, label: "Pending deploy", tone: "warning" }
  return { detail: state.message, label: "Unavailable", tone: "danger" }
}
