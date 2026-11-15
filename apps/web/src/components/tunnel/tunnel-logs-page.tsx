import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { linkOptions, useSearch } from "@tanstack/react-router"

import {
  InstanceLogsPage,
  LISTED_DEPLOYMENTS,
  RequestDeploymentLog,
  requestDeploymentEntry,
  type InstanceLogsLinks,
  type LogSource,
} from "@/components/console/instance-logs-page"
import { DEPLOYMENT_STREAM } from "@/components/console/log-sources"
import { ResourceLogsSession } from "@/components/console/resource-logs"
import { useTunnelWorkspace } from "@/components/tunnel/tunnel-workspace-context"
import { getTunnelDeployments } from "@/server/tunnel-instances"

// A tunnel's output in one place: each of its two containers, followed
// live, and the log of each deployment the Relay kept.

const TAILSCALE = "tailscale"
const COREDNS = "coredns"

export function TunnelLogsPage() {
  const { tunnel } = useTunnelWorkspace()
  const { deployment: requested, stream } = useSearch({
    from: "/_app/tunnel/$tunnelId/logs",
  })
  const { data: records = [], isPending } = useQuery({
    queryKey: ["tunnels", tunnel.id, "deployments"],
    queryFn: () => getTunnelDeployments({ data: { tunnelId: tunnel.id } }),
    select: (page) => page.items.slice(0, LISTED_DEPLOYMENTS),
    // A deployment that runs is followed until it ends.
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === "running")
        ? 2_000
        : false,
  })
  const deployments = React.useMemo(
    () => records.map((record) => requestDeploymentEntry(record, "Redeploy")),
    [records]
  )
  const links = React.useMemo((): InstanceLogsLinks => {
    const here = {
      params: { tunnelId: tunnel.id },
      to: "/tunnel/$tunnelId/logs",
    } as const
    return {
      all: linkOptions({
        search: { relayId: tunnel.relayId },
        to: "/infra/deployments",
      }),
      deployment: (id) => linkOptions({ ...here, search: { deployment: id } }),
      latest: linkOptions({ ...here, search: { stream: DEPLOYMENT_STREAM } }),
      source: (id) =>
        linkOptions({
          ...here,
          search: id === TAILSCALE ? {} : { stream: id },
        }),
    }
  }, [tunnel.id, tunnel.relayId])
  const sources = React.useMemo(
    (): Array<LogSource> => [
      {
        heading: { title: "Tailscale" },
        id: TAILSCALE,
        meta: "Tailscale",
        status: {
          label: tunnel.components.tailscaleRunning ? "Running" : "Stopped",
          tone: tunnel.components.tailscaleRunning ? "success" : "neutral",
        },
        title: "Tailscale",
      },
      {
        heading: { title: "CoreDNS" },
        id: COREDNS,
        meta: "CoreDNS",
        status: {
          label: tunnel.components.coreDnsRunning ? "Running" : "Stopped",
          tone: tunnel.components.coreDnsRunning ? "success" : "neutral",
        },
        title: "CoreDNS",
      },
    ],
    [tunnel.components.coreDnsRunning, tunnel.components.tailscaleRunning]
  )
  const latest = records[0]
  return (
    <InstanceLogsPage
      deployments={deployments}
      latestId={latest?.id}
      links={links}
      renderDeployment={(id, header) => (
        <RequestDeploymentLog
          header={header}
          instance={{ id: tunnel.id, kind: "tunnel", name: tunnel.name }}
          pending={isPending}
          record={
            id === null
              ? latest
              : (records.find((record) => record.id === id) ?? {
                  error: null,
                  id,
                  status: "unknown",
                })
          }
          shareLink={links.deployment}
        />
      )}
      renderSource={(id, header) => (
        <ResourceLogsSession
          key={`${tunnel.relayId}:${tunnel.id}:${id}`}
          header={header}
          id={tunnel.id}
          kind="tunnel"
          logName={`${tunnel.name}-${id}`}
          relayAvailable
          relayId={tunnel.relayId}
          stream={id}
        />
      )}
      showing={
        requested !== undefined
          ? { id: requested, kind: "deployment" }
          : stream === DEPLOYMENT_STREAM
            ? { id: null, kind: "deployment" }
            : { id: stream === COREDNS ? COREDNS : TAILSCALE, kind: "source" }
      }
      sources={sources}
    />
  )
}
