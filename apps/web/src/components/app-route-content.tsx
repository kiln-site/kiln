import * as React from "react"
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import {
  useMatch,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"

import { AppWorkspaceShell } from "@/components/app/app-workspace"
import { DatabaseWorkspaceShell } from "@/components/database/database-workspace"
import { EmptyServerState } from "@/components/empty-server-state"
import { InfraShell } from "@/components/infra-layout"
import { InstanceRouteFrame } from "@/components/instance-route-frame"
import { InstanceWorkspaceShell } from "@/components/instance-workspace"
import { KilnWorkspaceShell } from "@/components/kiln/kiln-workspace"
import { RelayWorkspaceShell } from "@/components/relay/relay-workspace"
import { RelayUnavailableState } from "@/components/relay-unavailable-state"
import { SettingsShell } from "@/components/settings-layout"
import { AutomationsShell } from "@/components/automations-layout"
import { BackupsShell } from "@/components/backups-layout"
import { GlobalPageToolbar } from "@/components/global-page-toolbar"
import { WorkspaceFrame } from "@/components/workspace-frame"
import {
  accessCapabilitiesQueryOptions,
  relayConnectionQueryOptions,
} from "@/lib/query-options"
import { selectRelayConnectionSummary } from "@/lib/relay-selectors"
import {
  serverWorkspaceQueryOptions,
  type ServerWorkspace,
} from "@/lib/server-workspace"
import { useRouteServerId } from "@/lib/use-server-workspace"
import { globalSectionFromRouteId } from "@/lib/route-sections"
import type { GlobalSection } from "@/lib/route-sections"

export function AppRouteContent({ children }: { children: React.ReactNode }) {
  return <AppRouteViewport>{children}</AppRouteViewport>
}

function AppRouteViewport({ children }: { children: React.ReactNode }) {
  const routeFrame = useRouterState({
    select: (state) => {
      const routeId = state.matches.at(-1)?.routeId
      if (routeId?.startsWith("/_app/db/")) return "database"
      if (routeId?.startsWith("/_app/app/")) return "app"
      if (routeId?.startsWith("/_app/relay/")) return "relay"
      if (routeId?.startsWith("/_app/kiln")) return "kiln"
      return state.matches.some(
        (match) => match.status === "notFound" || match._notFound
      )
        ? "not-found"
        : globalSectionFromRouteId(routeId)
    },
  })

  if (routeFrame === "database") {
    return <DatabaseWorkspaceShell>{children}</DatabaseWorkspaceShell>
  }
  if (routeFrame === "app") {
    return <AppWorkspaceShell>{children}</AppWorkspaceShell>
  }
  if (routeFrame === "relay") {
    return <RelayWorkspaceShell>{children}</RelayWorkspaceShell>
  }
  if (routeFrame === "kiln") {
    return <KilnWorkspaceShell>{children}</KilnWorkspaceShell>
  }
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
        ) : section === "backups" ? (
          <BackupsShell>{children}</BackupsShell>
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
  const serverId = useRouteServerId()
  if (!serverId || serverId === "unavailable") return <RouteEmptyState />
  return (
    <ServerRouteBoundary serverId={serverId}>{children}</ServerRouteBoundary>
  )
}

// The route reads the server's own workspace, usually before it renders; a
// server the page already knew opens at once and its read lands after. The
// fleet is read only to explain an empty state.
function ServerRouteBoundary({
  children,
  serverId,
}: {
  children: React.ReactNode
  serverId: string
}) {
  const opened = useMatch({
    from: "/_app/server/$serverId",
    select: selectOpenedServer,
    shouldThrow: false,
    structuralSharing: true,
  })
  // Read on its own: a failed resolution leaves the match without a server.
  const matchStatus = useMatch({
    from: "/_app/server/$serverId",
    select: (match) => match.status,
    shouldThrow: false,
  })
  const {
    data: route,
    error,
    isError,
  } = useQuery({
    ...serverWorkspaceQueryOptions(serverId),
    select: React.useCallback(
      (workspace: ServerWorkspace) => routeVerdict(workspace, serverId, opened),
      [opened, serverId]
    ),
  })
  const router = useRouter()
  // An open the read disagrees with resolves again, which redirects as a
  // navigation would have: to the list, an invitation, or the canonical URL.
  const misrouted =
    opened?.verified === false && route !== undefined && route !== "open"
  React.useEffect(() => {
    if (misrouted) void router.invalidate()
  }, [misrouted, router])

  // A route whose resolution failed shows the route's error page, with its
  // retry, as the awaited route would have.
  if (matchStatus === "error") return children
  if (isError && (route === undefined || misrouted)) throw error
  if (route === undefined || misrouted)
    return <div className="min-h-0 flex-1 bg-background" />
  if (route === "missing") return <RouteEmptyState />
  return <InstanceRouteFrame serverId={serverId}>{children}</InstanceRouteFrame>
}

interface OpenedServer {
  brickId?: string | null
  id: string
  relayId: string
  verified: boolean
}

function selectOpenedServer(match: {
  context: {
    instance: { brickId?: string | null; id: string; relayId: string } | null
    serverVerified: boolean
  }
}): OpenedServer | undefined {
  const { instance, serverVerified } = match.context
  return instance
    ? {
        brickId: instance.brickId ?? null,
        id: instance.id,
        relayId: instance.relayId,
        verified: serverVerified,
      }
    : undefined
}

// What the server's own read says about the route that opened it. A route
// that opened on a known server, before its read, is confirmed only by the
// same server: its access checks ran for that one.
function routeVerdict(
  workspace: ServerWorkspace,
  serverId: string,
  opened: OpenedServer | undefined
): "missing" | "moved" | "open" {
  if (workspace.status !== "found") return "missing"
  const [instance] = workspace.snapshot.instances
  const canonical =
    serverId === workspace.routeIdentifier || serverId === instance?.routeId
  const sameServer =
    !opened ||
    opened.verified ||
    (instance?.id === opened.id &&
      instance.relayId === opened.relayId &&
      (instance.brickId ?? null) === opened.brickId)
  return canonical && sameServer ? "open" : "moved"
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
