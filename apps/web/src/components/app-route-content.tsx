import * as React from "react"
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { useNavigate, useRouterState } from "@tanstack/react-router"

import { EmptyServerState } from "@/components/empty-server-state"
import { InfraShell } from "@/components/infra-layout"
import { InstanceRouteFrame } from "@/components/instance-route-frame"
import { InstanceWorkspaceShell } from "@/components/instance-workspace"
import { RelayUnavailableState } from "@/components/relay-unavailable-state"
import { SettingsShell } from "@/components/settings-layout"
import { AutomationsShell } from "@/components/automations-layout"
import { GlobalPageToolbar } from "@/components/global-page-toolbar"
import { WorkspaceFrame } from "@/components/workspace-frame"
import {
  accessCapabilitiesQueryOptions,
  relayConnectionQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import {
  findRelayInstance,
  selectRelayConfigured,
  selectRelayConnectionSummary,
  selectSidebarInstances,
} from "@/lib/relay-selectors"
import type { SidebarInstance } from "@/lib/relay-selectors"
import { globalSectionFromRouteId } from "@/lib/route-sections"
import type { GlobalSection } from "@/lib/route-sections"

const emptyInstances: Array<SidebarInstance> = []

export function AppRouteContent({ children }: { children: React.ReactNode }) {
  return <AppRouteViewport>{children}</AppRouteViewport>
}

function AppRouteViewport({ children }: { children: React.ReactNode }) {
  const routeFrame = useRouterState({
    select: (state) =>
      state.matches.some(
        (match) => match.status === "notFound" || match.globalNotFound
      )
        ? "not-found"
        : globalSectionFromRouteId(state.matches.at(-1)?.routeId),
  })

  if (routeFrame === "not-found") {
    return <NotFoundRouteFrame>{children}</NotFoundRouteFrame>
  }
  if (routeFrame) {
    return <GlobalRouteFrame section={routeFrame}>{children}</GlobalRouteFrame>
  }
  return <InstanceRouteViewport>{children}</InstanceRouteViewport>
}

const NotFoundRouteFrame = React.memo(function NotFoundRouteFrame({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <WorkspaceFrame header={<GlobalPageToolbar title="Not found" />}>
      {children}
    </WorkspaceFrame>
  )
})

const GlobalRouteFrame = React.memo(function GlobalRouteFrame({
  children,
  section,
}: {
  children: React.ReactNode
  section: Exclude<GlobalSection, null>
}) {
  return (
    <WorkspaceFrame header={<GlobalPageToolbar section={section} />}>
      <div
        data-slot="global-route-content"
        className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background/55"
      >
        {section === "infra" ? (
          <InfraShell>{children}</InfraShell>
        ) : section === "settings" ? (
          <SettingsShell>{children}</SettingsShell>
        ) : section === "automations" ? (
          <AutomationsShell>{children}</AutomationsShell>
        ) : (
          children
        )}
      </div>
    </WorkspaceFrame>
  )
})

const InstanceRouteViewport = React.memo(function InstanceRouteViewport({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <InstanceWorkspaceShell>
      <InstanceRouteBoundary>{children}</InstanceRouteBoundary>
    </InstanceWorkspaceShell>
  )
})

function InstanceRouteBoundary({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const { data: configured } = useSuspenseQuery({
    ...relayConnectionQueryOptions(queryClient),
    select: selectRelayConfigured,
  })
  const snapshotQuery = useQuery({
    ...relaySnapshotQueryOptions(),
    enabled: configured,
    select: selectSidebarInstances,
  })
  const serverId = useRouterState({
    select: (state) =>
      (state.matches.at(-1)?.params as { serverId?: string } | undefined)
        ?.serverId,
  })

  if (!configured) return <RouteEmptyState />
  if (!snapshotQuery.data)
    return <div className="min-h-0 flex-1 bg-background" />
  if (
    serverId &&
    findRelayInstance(snapshotQuery.data ?? emptyInstances, serverId)
  ) {
    return (
      <InstanceRouteFrame serverId={serverId}>{children}</InstanceRouteFrame>
    )
  }
  return <RouteEmptyState />
}

function RouteEmptyState() {
  const queryClient = useQueryClient()
  const connectionQuery = useSuspenseQuery({
    ...relayConnectionQueryOptions(queryClient),
    select: selectRelayConnectionSummary,
  })
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const navigate = useNavigate()
  const retry = React.useCallback(async () => {
    await connectionQuery.refetch()
  }, [connectionQuery.refetch])
  const configure = React.useCallback(() => {
    void navigate({ to: "/infra/relays" })
  }, [navigate])

  return connectionQuery.data.status === "connected" ? (
    <EmptyServerState canProvision={capabilities.canManageRelays} />
  ) : (
    <RelayUnavailableState
      connection={connectionQuery.data}
      canConfigure={capabilities.canManageRelays}
      onRetry={retry}
      onConfigure={configure}
    />
  )
}
