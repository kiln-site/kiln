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
import { DEPLOYMENT_STREAM, LogMessage } from "@/components/console/log-sources"
import { ResourceLogsSession } from "@/components/console/resource-logs"
import { gatewayStream } from "@/components/tunnel/tunnel-data"
import { useTunnelWorkspace } from "@/components/tunnel/tunnel-workspace-context"
import { getTunnelDeployments } from "@/server/tunnel-instances"

// A tunnel's output in one place: each gateway's Tailscale and CoreDNS,
// followed live and labelled by the Relay it's on, and the log of each
// deployment of any of them the Relays kept.

const CONTAINERS = [
  { id: "tailscale", title: "Tailscale" },
  { id: "coredns", title: "CoreDNS" },
] as const

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
    () =>
      records.map((record) =>
        requestDeploymentEntry(record, `Redeploy on ${record.relayName}`)
      ),
    [records]
  )
  const links = React.useMemo((): InstanceLogsLinks => {
    const here = {
      params: { tunnelId: tunnel.id },
      to: "/tunnel/$tunnelId/logs",
    } as const
    return {
      all: linkOptions({ to: "/infra/deployments" }),
      deployment: (id) => linkOptions({ ...here, search: { deployment: id } }),
      latest: linkOptions({ ...here, search: { stream: DEPLOYMENT_STREAM } }),
      source: (id) => linkOptions({ ...here, search: { stream: id } }),
    }
  }, [tunnel.id])
  const sources = React.useMemo(
    (): Array<LogSource> =>
      tunnel.gateways.flatMap((gateway) =>
        CONTAINERS.map((container) => {
          const running =
            container.id === "tailscale"
              ? gateway.components.tailscaleRunning
              : gateway.components.coreDnsRunning
          return {
            heading: {
              meta: `on ${gateway.relayName}`,
              title: container.title,
            },
            id: gatewayStream(gateway.id, container.id),
            meta: gateway.relayName,
            status: {
              label: running ? "Running" : "Stopped",
              tone: running ? "success" : "neutral",
            },
            title: container.title,
          }
        })
      ),
    [tunnel.gateways]
  )
  const latest = records[0]
  const shownSource =
    sources.find((source) => source.id === stream)?.id ?? sources[0]?.id
  return (
    <InstanceLogsPage
      deployments={deployments}
      latestId={latest?.id}
      links={links}
      renderDeployment={(id, header) => {
        const record =
          id === null
            ? latest
            : records.find((candidate) => candidate.id === id)
        return (
          <RequestDeploymentLog
            header={header}
            instance={{
              id: record?.gatewayId ?? "",
              kind: "gateway",
              name: `${tunnel.name} on ${record?.relayName ?? "its Relay"}`,
            }}
            pending={isPending}
            record={
              record ??
              (id === null ? undefined : { error: null, id, status: "unknown" })
            }
            shareLink={links.deployment}
          />
        )
      }}
      renderSource={(id, header) => {
        const [gatewayId, container] = id.split(":")
        const gateway = tunnel.gateways.find(
          (candidate) => candidate.id === gatewayId
        )
        if (!gateway || !container) {
          return (
            <LogMessage
              header={header}
              message="This gateway is gone. Pick another source."
            />
          )
        }
        return (
          <ResourceLogsSession
            key={`${gateway.relayId}:${gateway.id}:${container}`}
            header={header}
            id={gateway.id}
            kind="tunnel"
            logName={`${tunnel.name}-${gateway.relayName}-${container}`}
            relayAvailable
            relayId={gateway.relayId}
            stream={container}
          />
        )
      }}
      showing={
        requested !== undefined
          ? { id: requested, kind: "deployment" }
          : stream === DEPLOYMENT_STREAM || shownSource === undefined
            ? { id: null, kind: "deployment" }
            : { id: shownSource, kind: "source" }
      }
      sources={sources}
    />
  )
}
