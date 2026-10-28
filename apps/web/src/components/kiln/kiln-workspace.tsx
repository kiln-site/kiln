import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useRouterState } from "@tanstack/react-router"

import { HearthMark } from "@/components/hearth-mark"
import { InfraUpdatesButton } from "@/components/infra-layout"
import {
  KilnRefreshButton,
  KilnRepairButton,
} from "@/components/kiln/kiln-actions"
import {
  kilnPresentation,
  kilnVersion,
  useKilnHost,
} from "@/components/kiln/kiln-presentation"
import { WorkspaceFrame } from "@/components/workspace-frame"
import {
  WorkspaceCopyValueButton,
  WorkspaceHeader,
  WorkspaceIdentity,
  WorkspaceMetaSeparator,
} from "@/components/workspace-header"
import { kilnDestinations } from "@/lib/navigation-destinations"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

// Kiln's pages share a header naming it, the Relay it runs beside, and where
// people open it, with what applies to all of its services.
export const KilnWorkspaceShell = React.memo(function KilnWorkspaceShell({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <WorkspaceFrame
      header={
        <React.Suspense fallback={<WorkspaceHeader identity={null} />}>
          <KilnWorkspaceHeader />
        </React.Suspense>
      }
    >
      <React.Suspense fallback={<div className="min-h-0 flex-1 bg-card" />}>
        <KilnWorkspaceBoundary>{children}</KilnWorkspaceBoundary>
      </React.Suspense>
    </WorkspaceFrame>
  )
})

function KilnWorkspaceBoundary({ children }: { children: React.ReactNode }) {
  const host = useKilnHost()
  // Operations are Hearth's own, whichever Relay reports its services.
  const hostless = useRouterState({
    select: (state) => state.location.pathname === "/kiln/operations",
  })
  if (host || hostless) return children
  return (
    <section className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
      <div className="max-w-md">
        <HearthMark className="mx-auto mb-4 size-11 opacity-70" />
        <p className="type-card-title">No Relay reports Kiln's services</p>
        <p className="type-meta mt-2 text-muted-foreground">
          A Relay shows Hearth, its database, and the Traefik in front of them
          here when it runs on their Docker host, whether it installed them or
          they were deployed with Compose or Coolify.
        </p>
      </div>
    </section>
  )
}

const KilnWorkspaceHeader = React.memo(function KilnWorkspaceHeader() {
  const host = useKilnHost()
  const status = host?.status ?? null
  const version = kilnVersion(status)
  const presentation = kilnPresentation(host)
  const { data: canUpdate } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectCanUpdateRelays,
  })
  return (
    <WorkspaceHeader
      identity={
        <WorkspaceIdentity
          name="Kiln"
          statusConfirmed
          title={<KilnRouteTitle />}
        >
          {presentation.tone !== "success" ? (
            <>
              <span className="shrink-0">{presentation.label}</span>
              <WorkspaceMetaSeparator />
            </>
          ) : null}
          {version ? (
            <>
              <span className="shrink-0 font-mono">{version}</span>
              <WorkspaceMetaSeparator />
            </>
          ) : null}
          {host ? (
            <span className="hidden shrink-0 items-center gap-1.5 @[32rem]:inline-flex">
              <span className="truncate">On {host.relayName}</span>
              {status?.hearthUrl ? <WorkspaceMetaSeparator /> : null}
            </span>
          ) : null}
          {status?.hearthUrl ? (
            <WorkspaceCopyValueButton
              label="Kiln's address"
              value={status.hearthUrl}
            />
          ) : null}
        </WorkspaceIdentity>
      }
      actions={
        <div className="flex shrink-0 items-center gap-2">
          {host && status?.canManage ? (
            <KilnRepairButton relayId={host.relayId} />
          ) : null}
          {canUpdate ? <InfraUpdatesButton className="shrink-0" /> : null}
          <KilnRefreshButton />
        </div>
      }
    />
  )
})

function selectCanUpdateRelays(capabilities: { canUpdateRelays: boolean }) {
  return capabilities.canUpdateRelays
}

function KilnRouteTitle() {
  const title = useRouterState({
    select: (state) => {
      const segment = state.location.pathname.split("/")[2]
      return (
        kilnDestinations.find(
          (destination) => destination.to.split("/")[2] === segment
        )?.label ?? "Info"
      )
    },
  })
  return <>{title}</>
}
