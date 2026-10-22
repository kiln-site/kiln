import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  ArrowRightLeft,
  GitCommitHorizontal,
  History,
  KeyRound,
  Rocket,
  ScrollText,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { AppDocumentDialog } from "@/components/app/app-config-dialogs"
import { AppImageUpdatesFact } from "@/components/app/app-image-updates"
import {
  deploymentStatusPresentation,
  shortCommit,
} from "@/components/app/app-deployment-presentation"
import {
  appContainers,
  appRelayAvailable,
  sourceTypeLabels,
  type App,
} from "@/components/app/app-presentation"
import { GitHubMark } from "@/components/github-mark"
import {
  InfoFact,
  InfoRailButton,
  InfoRailCard,
  InfoRailGroup,
  InfoRailLink,
  InfoRailRow,
} from "@/components/info-page"
import { DatabaseKindIcon } from "@/components/instance-kind-icon"
import { OwnerCard } from "@/components/owner-card"
import { RelativeTime } from "@/components/relative-time"
import { InfoRailRelayLink } from "@/components/resource-info-rail"
import { StatusIndicator } from "@/components/status-indicator"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"
import {
  appConfigQueryOptions,
  appDeploymentSummaryQueryOptions,
  appOwnerMinecraftProfileQueryOptions,
  appOwnerQueryOptions,
} from "@/lib/query-options"

// What the app is at a glance: the Relay it runs on, the databases it
// reaches, and its environment, who owns it, and its deployment. Its name and status are in the
// header.
export function AppInfoRail({ app, routeId }: { app: App; routeId: string }) {
  const databases = app.connectedDatabaseIds.length
  return (
    <>
      <InfoRailGroup card>
        <InfoRailRelayLink name={app.relayName} relayId={app.relayId} />
        <InfoRailLink
          to="/app/$appId/network"
          params={{ appId: routeId }}
          leading={<DatabaseKindIcon />}
          detail={
            <span
              className="tabular-nums"
              title={
                databases === 1
                  ? "1 database connected"
                  : `${databases} databases connected`
              }
            >
              {databases}
            </span>
          }
        >
          Databases
        </InfoRailLink>
        <AppEnvironmentRow app={app} routeId={routeId} />
      </InfoRailGroup>
      <AppOwner appId={app.id} relayId={app.relayId} />
      <AppDeploymentCard app={app} routeId={routeId} />
    </>
  )
}

// The app's variables, counted, opening the .env editor. Only those who
// manage the app get its environment at all.
const AppEnvironmentRow = React.memo(function AppEnvironmentRow({
  app,
  routeId,
}: {
  app: App
  routeId: string
}) {
  const [open, setOpen] = React.useState(false)
  const { data } = useQuery({
    ...appConfigQueryOptions(app.relayId, app.id),
    select: environmentSummary,
  })
  const leading = <KeyRound />
  if (!data || data.hidden) {
    return (
      <InfoRailRow
        leading={leading}
        detail={
          <span className="font-normal text-muted-foreground">
            {data ? "Hidden" : "…"}
          </span>
        }
      >
        Environment
      </InfoRailRow>
    )
  }
  return (
    <>
      <InfoRailButton
        leading={leading}
        detail={
          <span
            className="tabular-nums"
            title={data.count === 1 ? "1 variable" : `${data.count} variables`}
          >
            {data.count}
          </span>
        }
        onPointerEnter={warmSyntaxCodeEditorModule}
        onFocus={warmSyntaxCodeEditorModule}
        onClick={() => {
          warmSyntaxCodeEditorModule()
          setOpen(true)
        }}
      >
        Environment
      </InfoRailButton>
      {open ? (
        <AppDocumentDialog
          app={app}
          canManage={
            app.permissions.includes("app.manage") && appRelayAvailable(app)
          }
          deploying={app.deployment?.state === "running"}
          kind="environment"
          routeId={routeId}
          saved={data.environment}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
})

function environmentSummary({
  config,
  environmentHidden,
}: {
  config: { environment: string }
  environmentHidden: boolean
}) {
  const count = config.environment.split("\n").filter((line) => {
    const trimmed = line.trim()
    return trimmed && !trimmed.startsWith("#") && trimmed.includes("=")
  }).length
  return { count, environment: config.environment, hidden: environmentHidden }
}

// Loaded on first click, so the rail doesn't carry it.
const AppTransferOwnershipDialog = React.lazy(async () => ({
  default: (await import("@/components/app/app-transfer-ownership-dialog"))
    .AppTransferOwnershipDialog,
}))

// Shows once the owner loads, so it doesn't stand in for the platform first.
const AppOwner = React.memo(function AppOwner({
  appId,
  relayId,
}: {
  appId: string
  relayId: string
}) {
  const { data } = useQuery(appOwnerQueryOptions(relayId, appId))
  const owner = data?.owner
  const { data: profileId } = useQuery({
    ...appOwnerMinecraftProfileQueryOptions(relayId, appId, owner?.name ?? ""),
    enabled: Boolean(owner),
  })
  const [transferring, setTransferring] = React.useState(false)
  const [transferMounted, setTransferMounted] = React.useState(false)
  if (data === undefined) return null
  return (
    <>
      <OwnerCard
        action={
          data.canTransfer ? (
            <Button
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => {
                setTransferMounted(true)
                setTransferring(true)
              }}
            >
              <ArrowRightLeft /> Transfer
            </Button>
          ) : null
        }
        email={owner?.email ?? null}
        name={owner?.name ?? null}
        profileId={profileId}
      />
      {transferMounted ? (
        <React.Suspense fallback={null}>
          <AppTransferOwnershipDialog
            appId={appId}
            open={transferring}
            relayId={relayId}
            onOpenChange={setTransferring}
          />
        </React.Suspense>
      ) : null}
    </>
  )
})

// Where the app deploys from, what it runs now, and the way to its
// deployments and their logs.
const AppDeploymentCard = React.memo(function AppDeploymentCard({
  app,
  routeId,
}: {
  app: App
  routeId: string
}) {
  const { data: summary } = useQuery(
    appDeploymentSummaryQueryOptions(app.relayId, app.id)
  )
  // What the running containers were built from, as the Relay labels them.
  const runningCommit =
    appContainers(app).find((container) => container.running)?.labels[
      "kiln.app.commit"
    ] ?? null
  const current =
    summary?.current?.commitSha === runningCommit ? summary?.current : null
  const latest = summary?.latest ?? null
  const source = summary?.source ?? null
  const canReadLogs = app.permissions.includes("app.logs.read")
  return (
    <InfoRailCard
      icon={<Rocket />}
      title="Deployment"
      action={
        latest ? (
          <StatusIndicator status={deploymentStatusPresentation(latest)} />
        ) : null
      }
      sections={
        <div className="grid grid-cols-2 divide-x divide-border/60 border-t">
          <Link
            to="/infra/deployments"
            search={{ appId: app.id, relayId: app.relayId }}
            className={railFooterLinkClassName}
          >
            <History />
            History
          </Link>
          {canReadLogs ? (
            <Link
              to="/app/$appId/logs"
              params={{ appId: routeId }}
              search={{ stream: "deployment" }}
              className={railFooterLinkClassName}
            >
              <ScrollText />
              Logs
            </Link>
          ) : (
            <span
              className={cn(
                railFooterLinkClassName,
                "pointer-events-none opacity-50"
              )}
            >
              <ScrollText />
              Logs
            </span>
          )}
        </div>
      }
    >
      <InfoFact label="Source">
        {source ? (
          <a
            className="flex min-w-0 items-center gap-1.5 hover:text-primary-ink"
            href={source.repositoryUrl}
            rel="noreferrer"
            target="_blank"
            title={`${source.repository} on ${source.branch}`}
          >
            <GitHubMark className="size-3.5 shrink-0" />
            <span className="truncate font-mono text-xs">
              {source.repository}
            </span>
          </a>
        ) : (
          <span className="text-muted-foreground">
            {summary ? sourceTypeLabels[summary.sourceType] : "…"}
          </span>
        )}
      </InfoFact>
      {/* Held in place for GitHub apps, so a deploy finishing in the
          background doesn't move the card. */}
      {summary?.sourceType === "github" ? (
        <InfoFact label="Running">
          {runningCommit ? (
            <a
              className="flex min-w-0 items-center gap-1.5 hover:text-primary-ink"
              href={
                current?.commitUrl ??
                (source
                  ? `${source.repositoryUrl}/commit/${runningCommit}`
                  : undefined)
              }
              rel="noreferrer"
              target="_blank"
              title={current?.commitMessage ?? runningCommit}
            >
              <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-mono text-xs">
                {shortCommit(runningCommit)}
              </span>
              {current?.commitMessage ? (
                <span className="truncate text-xs text-muted-foreground">
                  {current.commitMessage}
                </span>
              ) : null}
            </a>
          ) : (
            <span className="text-muted-foreground">Not running</span>
          )}
        </InfoFact>
      ) : null}
      {summary?.imageUpdates ? (
        <AppImageUpdatesFact
          app={app}
          routeId={routeId}
          updates={summary.imageUpdates}
        />
      ) : null}
      <InfoFact
        label={latest?.status === "running" ? "Started" : "Last deploy"}
      >
        {latest ? (
          <RelativeTime timestamp={Date.parse(latest.startedAt)} />
        ) : (
          <span className="text-muted-foreground">
            {summary ? "Never" : "…"}
          </span>
        )}
      </InfoFact>
    </InfoRailCard>
  )
})

const railFooterLinkClassName =
  "flex h-9 items-center justify-center gap-1.5 text-xs text-muted-foreground transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset [&_svg]:size-3.5"
