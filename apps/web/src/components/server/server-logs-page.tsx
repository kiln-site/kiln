import * as React from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { linkOptions, useSearch } from "@tanstack/react-router"

import { serverDeploymentTriggerLabels } from "@/components/app/app-deployment-presentation"
import {
  InstanceLogsPage,
  LISTED_DEPLOYMENTS,
  RequestDeploymentLog,
  requestDeploymentEntry,
  type InstanceLogsLinks,
} from "@/components/console/instance-logs-page"
import { useInstanceIdentity } from "@/components/instance-workspace-context"
import { deploymentsQueryOptions } from "@/lib/query-options"
import type { DeploymentView } from "@/server/app-deployments.server"

function listedDeployments(data: {
  pages: ReadonlyArray<{ items: ReadonlyArray<DeploymentView> }>
}) {
  return (data.pages[0]?.items ?? [])
    .flatMap((item) => (item.kind === "server" ? [item] : []))
    .slice(0, LISTED_DEPLOYMENTS)
}

// The log of each of a game server's deployments the Relay kept: its
// install, each redeploy, and each change of Brick. Its own output is its
// console, which has a page of its own.
export function ServerLogsPage() {
  const instance = useInstanceIdentity()
  const { deployment: requested } = useSearch({
    from: "/_app/server/$serverId/logs",
  })
  const { data: records = [], isPending } = useInfiniteQuery({
    ...deploymentsQueryOptions({
      instance: { id: instance.id, kind: "server" },
      relayId: instance.relayId,
    }),
    select: listedDeployments,
  })
  const deployments = React.useMemo(
    () =>
      records.map((record) =>
        requestDeploymentEntry(
          record,
          serverDeploymentTriggerLabels[record.trigger]
        )
      ),
    [records]
  )
  const links = React.useMemo((): InstanceLogsLinks => {
    const here = {
      params: { serverId: instance.id },
      to: "/server/$serverId/logs",
    } as const
    const latest = linkOptions({ ...here, search: {} })
    return {
      all: linkOptions({
        search: { relayId: instance.relayId },
        to: "/infra/deployments",
      }),
      deployment: (id) => linkOptions({ ...here, search: { deployment: id } }),
      latest,
      source: () => latest,
    }
  }, [instance.id, instance.relayId])
  const latest = records[0]
  return (
    <InstanceLogsPage
      deployments={deployments}
      latestId={latest?.id}
      links={links}
      renderDeployment={(id, header) => (
        <RequestDeploymentLog
          header={header}
          instance={instance}
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
      renderSource={() => null}
      showing={{ id: requested ?? null, kind: "deployment" }}
      sources={null}
    />
  )
}
