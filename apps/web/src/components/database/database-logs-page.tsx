import * as React from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { linkOptions, useSearch } from "@tanstack/react-router"

import {
  InstanceLogsPage,
  LISTED_DEPLOYMENTS,
  RequestDeploymentLog,
  requestDeploymentEntry,
  type InstanceLogsLinks,
  type LogSource,
} from "@/components/console/instance-logs-page"
import { databaseDeploymentTriggerLabels } from "@/components/app/app-deployment-presentation"
import { DEPLOYMENT_STREAM } from "@/components/console/log-sources"
import { ResourceLogsSession } from "@/components/console/resource-logs"
import {
  databaseRelayAvailable,
  engineProductLabel,
} from "@/components/database/database-presentation"
import { useDatabaseWorkspace } from "@/components/database/database-workspace-context"
import { deploymentsQueryOptions } from "@/lib/query-options"
import type { DeploymentView } from "@/server/app-deployments.server"

// A database has one container, and while it's public, its gate's: each
// connection from outside, and each refusal, with the client's address.
const CONTAINER = "database"
const GATE = "public-gate"

function listedDeployments(data: {
  pages: ReadonlyArray<{ items: ReadonlyArray<DeploymentView> }>
}) {
  return (data.pages[0]?.items ?? [])
    .flatMap((item) => (item.kind === "database" ? [item] : []))
    .slice(0, LISTED_DEPLOYMENTS)
}

// A database's output in one place: its container, followed live, and the
// log of each deployment the Relay kept.
export function DatabaseLogsPage() {
  const { database } = useDatabaseWorkspace()
  const { deployment: requested, stream } = useSearch({
    from: "/_app/db/$databaseId/logs",
  })
  const { data: records = [], isPending } = useInfiniteQuery({
    ...deploymentsQueryOptions({
      instance: { id: database.id, kind: "database" },
      relayId: database.relayId,
    }),
    select: listedDeployments,
  })
  const deployments = React.useMemo(
    () =>
      records.map((record) =>
        requestDeploymentEntry(
          record,
          record.kind === "database"
            ? databaseDeploymentTriggerLabels[record.trigger]
            : "Redeploy"
        )
      ),
    [records]
  )
  const links = React.useMemo((): InstanceLogsLinks => {
    const here = {
      params: { databaseId: database.id },
      to: "/db/$databaseId/logs",
    } as const
    return {
      all: linkOptions({
        search: { relayId: database.relayId },
        to: "/infra/deployments",
      }),
      deployment: (id) => linkOptions({ ...here, search: { deployment: id } }),
      latest: linkOptions({ ...here, search: { stream: DEPLOYMENT_STREAM } }),
      source: (id) =>
        linkOptions({
          ...here,
          search: id === GATE ? { stream: GATE } : {},
        }),
    }
  }, [database.id, database.relayId])
  const running =
    database.observedState === "running" ||
    database.observedState === "starting"
  const product = engineProductLabel(database)
  const sources = React.useMemo(
    (): Array<LogSource> => [
      {
        heading: { title: product },
        id: CONTAINER,
        meta: product,
        status: {
          label: running ? "Running" : "Stopped",
          tone: running ? "success" : "neutral",
        },
        title: database.name,
      },
      ...(database.public
        ? [
            {
              heading: {
                meta: database.public.hostnames[0],
                title: "Public gate",
              },
              id: GATE,
              meta: database.public.hostnames[0],
              status:
                database.public.state === "open"
                  ? { label: "Open", tone: "success" as const }
                  : database.public.state === "failed"
                    ? { label: "Failed", tone: "danger" as const }
                    : { label: "Opening", tone: "neutral" as const },
              title: "db-public-gate",
            },
          ]
        : []),
    ],
    [database.name, database.public, product, running]
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
          instance={{ id: database.id, kind: "database", name: database.name }}
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
          key={`${database.relayId}:${database.id}:${id}`}
          header={header}
          id={database.id}
          kind="database"
          logName={id === GATE ? `${database.name} public gate` : database.name}
          relayAvailable={databaseRelayAvailable(database)}
          relayId={database.relayId}
          {...(id === GATE && { stream: GATE })}
        />
      )}
      showing={
        requested !== undefined
          ? { id: requested, kind: "deployment" }
          : stream === DEPLOYMENT_STREAM
            ? { id: null, kind: "deployment" }
            : stream === GATE && database.public
              ? { id: GATE, kind: "source" }
              : { id: CONTAINER, kind: "source" }
      }
      sources={sources}
    />
  )
}
