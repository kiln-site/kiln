import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { RelayAppWebRoute } from "@workspace/contracts"
import {
  Boxes,
  Cable,
  FileCode2,
  Globe2,
  KeyRound,
  LoaderCircle,
  Rocket,
  Settings2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import {
  AppDocumentDialog,
  AppSourceDialog,
  appDocuments,
  type AppDocumentKind,
  type EditableAppConfig,
} from "@/components/app/app-config-dialogs"
import { useAppContainerSelection } from "@/components/app/app-container-selection"
import {
  appAddresses,
  appContainers,
  appServices,
  showAppOperationError,
  sourceTypeLabels,
  type App,
} from "@/components/app/app-presentation"
import {
  InfoCopyValue,
  InfoDetails,
  InfoFact,
  InfoHint,
  InfoSection,
  InfoSectionLink,
} from "@/components/info-page"
import { InstanceFavoriteButton } from "@/components/instance-favorite"
import { RelativeTime } from "@/components/relative-time"
import { RenameButton } from "@/components/rename-dialog"
import { StatusIndicator } from "@/components/status-indicator"
import { appWebRoutesQueryOptions, queryKeys } from "@/lib/query-options"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"
import { deployApp, renameApp } from "@/server/apps"

// The app's details on its Info page, one section per concern, each with
// the actions that change it. What runs where is tagged with the service
// whose container serves it.

const APP_NAME_MAX_LENGTH = 120

export function AppGeneralSettings({
  app,
  canRename,
}: {
  app: App
  canRename: boolean
}) {
  const running = app.containers.filter((container) => container.running)
  return (
    <InfoSection
      icon={<Boxes />}
      title="App"
      action={
        <>
          {canRename ? <AppRenameButton app={app} /> : null}
          <InstanceFavoriteButton
            id={app.id}
            kind="app"
            relayId={app.relayId}
          />
        </>
      }
    >
      <InfoFact label="Name">
        <InfoCopyValue label="app name" mono={false} value={app.name} />
      </InfoFact>
      <InfoFact label="Kiln ID">
        <InfoCopyValue label="app ID" value={app.id} />
      </InfoFact>
      <InfoFact label="Containers">
        {app.containers.length === 0 ? (
          <span className="text-muted-foreground">Not deployed</span>
        ) : (
          <span className="tabular-nums">
            {running.length} of {app.containers.length} running
          </span>
        )}
      </InfoFact>
    </InfoSection>
  )
}

// Hearth keeps the name, so renaming doesn't need the Relay.
function AppRenameButton({ app }: { app: App }) {
  const queryClient = useQueryClient()
  const rename = React.useCallback(
    async (name: string) => {
      await renameApp({
        data: { appId: app.id, name, relayId: app.relayId },
      })
      await queryClient.invalidateQueries({ queryKey: queryKeys.apps.all })
    },
    [app.id, app.relayId, queryClient]
  )
  return (
    <RenameButton
      id={app.id}
      maxLength={APP_NAME_MAX_LENGTH}
      name={app.name}
      noun="app"
      rename={rename}
    />
  )
}

// What the app deploys from. The Dockerfile or Compose file opens in the
// code dialog; Configure changes the rest.
export function AppSourceSettings({
  app,
  canManage,
  config,
  routeId,
}: {
  app: App
  canManage: boolean
  config: EditableAppConfig
  routeId: string
}) {
  const [configuring, setConfiguring] = React.useState(false)
  const deploying = app.deployment?.state === "running"
  const kind = config.sourceType === "image" ? null : config.sourceType
  const singleContainer = config.sourceType !== "compose"
  const services = appServices(app)

  return (
    <InfoSection
      icon={<FileCode2 />}
      title="Source"
      action={
        <>
          {kind ? (
            <AppDocumentButton
              // Another document closes this one's editor, so a draft can't
              // save into the source that replaced it.
              key={kind}
              app={app}
              canManage={canManage}
              kind={kind}
              routeId={routeId}
              saved={config[kind]}
            />
          ) : null}
          {canManage ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setConfiguring(true)}
            >
              <Settings2 />
              Configure
            </Button>
          ) : null}
          {configuring ? (
            <AppSourceDialog
              app={app}
              deploying={deploying}
              routeId={routeId}
              saved={config}
              onOpenChange={setConfiguring}
            />
          ) : null}
        </>
      }
    >
      <InfoFact label="Type">{sourceTypeLabels[config.sourceType]}</InfoFact>
      {kind ? (
        <InfoFact label="File">
          <span className="font-mono text-xs">{appDocuments[kind].path}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {lineCount(config[kind])}
          </span>
        </InfoFact>
      ) : (
        <InfoFact label="Image">
          {config.image ? (
            <InfoCopyValue label="image" value={config.image} />
          ) : (
            <span className="text-muted-foreground">Not set</span>
          )}
        </InfoFact>
      )}
      {/* A Compose file names its own services; others run one, "app". */}
      {!singleContainer && services.length > 0 ? (
        <InfoFact label="Services">
          <span className="flex min-w-0 flex-wrap justify-end gap-1">
            {services.map((service) => (
              <ServiceTag key={service} app={app} service={service} />
            ))}
          </span>
        </InfoFact>
      ) : null}
      {singleContainer ? (
        <>
          <InfoFact label="Start command">
            {config.command ? (
              <InfoCopyValue label="start command" value={config.command} />
            ) : (
              <span className="text-muted-foreground">Image default</span>
            )}
          </InfoFact>
          <InfoFact label="Data mount">
            <InfoCopyValue label="data mount path" value={config.dataMount} />
          </InfoFact>
        </>
      ) : null}
    </InfoSection>
  )
}

// Opens a Dockerfile, Compose file, or the environment in the code dialog,
// to edit for those who manage the app and to read for everyone else.
function AppDocumentButton({
  app,
  canManage,
  children,
  kind,
  routeId,
  saved,
}: {
  app: App
  canManage: boolean
  children?: React.ReactNode
  kind: AppDocumentKind
  routeId: string
  saved: string
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onPointerEnter={warmSyntaxCodeEditorModule}
        onFocus={warmSyntaxCodeEditorModule}
        onClick={() => {
          warmSyntaxCodeEditorModule()
          setOpen(true)
        }}
      >
        {children ?? (
          <>
            <FileCode2 />
            {appDocuments[kind].path}
          </>
        )}
      </Button>
      {open ? (
        <AppDocumentDialog
          app={app}
          canManage={canManage}
          deploying={app.deployment?.state === "running"}
          kind={kind}
          routeId={routeId}
          saved={saved}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
}

// Variables by name only; their values open with the editor. Only those who
// manage the app get its environment at all.
export function AppEnvironmentSettings({
  app,
  canManage,
  environment,
  hidden,
  routeId,
}: {
  app: App
  canManage: boolean
  environment: string
  hidden: boolean
  routeId: string
}) {
  const names = React.useMemo(
    () => environmentVariableNames(environment),
    [environment]
  )
  return (
    <InfoSection
      icon={<KeyRound />}
      title="Environment"
      action={
        hidden ? null : (
          <AppDocumentButton
            app={app}
            canManage={canManage}
            kind="environment"
            routeId={routeId}
            saved={environment}
          >
            <FileCode2 />
            {canManage ? "Edit .env" : "View .env"}
          </AppDocumentButton>
        )
      }
    >
      <InfoFact label="Variables">
        {hidden ? (
          <>
            <span className="text-muted-foreground">Hidden</span>
            <InfoHint label="Why the environment is hidden" title="Hidden">
              <p>Only people who can configure this app see its environment.</p>
            </InfoHint>
          </>
        ) : names.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <InfoDetails
            title="Variables"
            trigger={
              <span className="tabular-nums">
                {names.length === 1
                  ? "1 variable"
                  : `${names.length} variables`}
              </span>
            }
          >
            <p>Passed to every container. Values show in the editor.</p>
            <ul className="flex flex-wrap gap-1">
              {names.map((name) => (
                <li
                  key={name}
                  className="border bg-muted/30 px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                >
                  {name}
                </li>
              ))}
            </ul>
          </InfoDetails>
        )}
      </InfoFact>
    </InfoSection>
  )
}

// The latest deployment, with its log a click away.
export function AppDeploymentSettings({
  app,
  canReadLogs,
  routeId,
}: {
  app: App
  canReadLogs: boolean
  routeId: string
}) {
  const deployment = app.deployment
  return (
    <InfoSection
      icon={<Rocket />}
      title="Deployment"
      status={
        deployment ? (
          <StatusIndicator status={deploymentStatus(deployment.state)} />
        ) : null
      }
      action={
        canReadLogs && deployment ? (
          <InfoSectionLink
            to="/app/$appId/logs"
            params={{ appId: routeId }}
            search={{ stream: "deployment" }}
          >
            Logs
          </InfoSectionLink>
        ) : null
      }
      content={!deployment}
    >
      {deployment ? (
        <>
          <InfoFact label="Deployment">
            <InfoCopyValue label="deployment ID" value={deployment.id} />
          </InfoFact>
          <InfoFact label="Source">
            {sourceTypeLabels[deployment.sourceType]}
          </InfoFact>
          <InfoFact label="Started">
            <RelativeTime timestamp={Date.parse(deployment.startedAt)} />
          </InfoFact>
          <InfoFact label="Finished">
            {deployment.finishedAt ? (
              <RelativeTime timestamp={Date.parse(deployment.finishedAt)} />
            ) : (
              <span className="text-muted-foreground">In progress</span>
            )}
          </InfoFact>
          {deployment.error ? (
            <InfoFact label="Error">
              <InfoDetails
                title="Deployment error"
                trigger={
                  <span className="font-mono text-xs text-destructive">
                    {deployment.error}
                  </span>
                }
              >
                <p className="font-mono break-words text-destructive">
                  {deployment.error}
                </p>
              </InfoDetails>
            </InfoFact>
          ) : null}
        </>
      ) : (
        <p className="text-[0.8125rem] text-muted-foreground">
          {app.containers.length > 0
            ? "Deployed before the Relay last restarted."
            : "Not deployed yet. Choose a source, then deploy."}
        </p>
      )}
    </InfoSection>
  )
}

// How the app's containers are reached: by name from inside the Relay, and
// on the Relay's ports for those it publishes.
export function AppConnectionSettings({
  app,
  routeId,
}: {
  app: App
  routeId: string
}) {
  // Each Compose service answers to its own name.
  const addresses = appAddresses(app)
  const ports = React.useMemo(
    () =>
      appContainers(app).flatMap((container) =>
        container.ports.map((port) => ({ port, service: container.service }))
      ),
    [app]
  )
  const databases = app.connectedDatabaseIds.length
  return (
    <InfoSection
      icon={<Cable />}
      title="Connection"
      action={
        <InfoSectionLink to="/app/$appId/network" params={{ appId: routeId }}>
          Network
        </InfoSectionLink>
      }
    >
      {addresses.map(({ address, service }) =>
        service ? (
          <InfoFact key={service} label={`${service} address`}>
            <InfoCopyValue label={`${service} address`} value={address} />
          </InfoFact>
        ) : (
          <InfoFact key="app" label="Internal address">
            <InfoCopyValue label="internal address" value={address} />
          </InfoFact>
        )
      )}
      <InfoFact label="Docker network">
        {app.network ? (
          <InfoCopyValue label="Docker network" value={app.network} />
        ) : (
          <span className="text-muted-foreground">Not created</span>
        )}
      </InfoFact>
      {ports.map(({ port, service }) => (
        <InfoFact
          key={`${port.hostPort}/${port.protocol}`}
          label={`Port ${port.hostPort}`}
        >
          <ServiceTarget
            app={app}
            port={`${port.containerPort}/${port.protocol}`}
            service={service}
          />
        </InfoFact>
      ))}
      <InfoFact label="Databases">
        <span className={databases === 0 ? "text-muted-foreground" : undefined}>
          {databases === 0 ? "None connected" : `${databases} connected`}
        </span>
      </InfoFact>
    </InfoSection>
  )
}

// Domains Traefik serves, each tagged with the service it reaches. The
// Network page adds and edits them.
export function AppWebRouteSettings({
  app,
  canManage,
  routeId,
}: {
  app: App
  canManage: boolean
  routeId: string
}) {
  const state = useQuery(appWebRoutesQueryOptions(app.relayId, app.id))
  const routes = state.data?.routes ?? []
  const empty = !state.data || routes.length === 0

  return (
    <InfoSection
      icon={<Globe2 />}
      title="Web routes"
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
          <InfoSectionLink to="/app/$appId/network" params={{ appId: routeId }}>
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
        routes.map((route) => (
          <WebRouteFact key={route.id} app={app} route={route} />
        ))
      )}
    </InfoSection>
  )
}

// A route reads like a fact: its address on the left, opening it, and the
// service and port it reaches on the right.
const WebRouteFact = React.memo(function WebRouteFact({
  app,
  route,
}: {
  app: App
  route: RelayAppWebRoute
}) {
  const address = `${route.hostname}${route.path ?? ""}`
  return (
    <div className="flex min-h-10 items-center gap-3 border-b border-border/60 py-1.5 text-[0.8125rem] last:border-b-0">
      <dt className="flex min-w-0 flex-1 items-baseline gap-2">
        <a
          className="truncate font-medium transition-colors hover:text-primary"
          href={`https://${address}`}
          rel="noreferrer"
          target="_blank"
          title={address}
        >
          {address}
        </a>
        <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">
          {route.name}
          {route.path && route.stripPrefix ? " · strips path" : ""}
        </span>
      </dt>
      <dd className="flex shrink-0 items-center justify-end">
        <ServiceTarget
          app={app}
          port={String(route.targetPort)}
          service={route.service}
        />
      </dd>
    </div>
  )
})

function DeployToApplyButton({ app }: { app: App }) {
  const queryClient = useQueryClient()
  const deploy = useMutation({
    mutationFn: () =>
      deployApp({ data: { appId: app.id, relayId: app.relayId } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
    onError: (error) => showAppOperationError("Deploy failed", error),
  })
  const deploying = deploy.isPending || app.deployment?.state === "running"
  return (
    <Button
      type="button"
      size="sm"
      disabled={deploying}
      onClick={() => deploy.mutate()}
    >
      {deploying ? <LoaderCircle className="animate-spin" /> : <Rocket />}
      Deploy to apply
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
// the rail's Container card.
function ServiceTag({ app, service }: { app: App; service: string }) {
  const selection = useAppContainerSelection()
  const container = app.containers.find(
    (candidate) => candidate.service === service
  )
  const state = !container
    ? "Not deployed"
    : container.running
      ? "Running"
      : "Stopped"
  return (
    <button
      type="button"
      title={`${service}: ${state}. Show its container.`}
      className="inline-flex items-center gap-1.5 border bg-muted/30 px-1.5 py-0.5 font-mono text-[11px] text-foreground transition-colors outline-none hover:border-primary/60 hover:text-primary focus-visible:border-primary"
      onClick={() => selection?.select({ service })}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          !container
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

function deploymentStatus(
  state: NonNullable<App["deployment"]>["state"]
): React.ComponentProps<typeof StatusIndicator>["status"] {
  if (state === "running")
    return { label: "Deploying", pulse: true, tone: "info" }
  if (state === "failed") return { label: "Failed", tone: "danger" }
  return { label: "Deployed", tone: "success" }
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

function lineCount(content: string): string {
  if (!content) return "Empty"
  const lines = content.replace(/\n$/u, "").split("\n").length
  return lines === 1 ? "1 line" : `${lines} lines`
}

function environmentVariableNames(environment: string): Array<string> {
  return environment.split("\n").flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) return []
    const name = trimmed
      .replace(/^export\s+/u, "")
      .split("=")[0]
      ?.trim()
    return name ? [name] : []
  })
}
