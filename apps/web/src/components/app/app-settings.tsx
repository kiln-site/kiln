import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { appFileRootId, primaryWebRoute } from "@workspace/contracts"
import type { RelayAppWebRoute } from "@workspace/contracts"
import {
  Cable,
  FileCode2,
  GitBranch,
  LoaderCircle,
  Rocket,
  Settings2,
  ToyBrick,
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
import { AppGitHubFileDialog } from "@/components/app/app-github-file-dialog"
import {
  appRelayAvailable,
  appServices,
  appStatusPresentation,
  showAppOperationError,
  type App,
} from "@/components/app/app-presentation"
import { EditableIcon } from "@/components/icon-editor-dialog"
import {
  InfoCopyValue,
  InfoFact,
  InfoProfile,
  InfoSection,
  InfoSectionLink,
} from "@/components/info-page"
import { GitHubMark } from "@/components/github-mark"
import { InstanceFavoriteButton } from "@/components/instance-favorite"
import { AppKindIcon } from "@/components/instance-kind-icon"
import { RenameButton } from "@/components/rename-dialog"
import { StatusIndicator } from "@/components/status-indicator"
import {
  appConfigQueryOptions,
  appDeploymentSummaryQueryOptions,
  appWebRoutesQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import type { AppGitHubSourceView } from "@/server/app-deployments.server"
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
  const available = appRelayAvailable(app)
  const compose = useAppRunsCompose(app)
  const services = appServices(app)
  const serviceKey = services.join("\n")
  const editor = React.useMemo(
    () => ({
      fallback: <AppKindIcon />,
      files: {
        rootId: appFileRootId(app.id),
        ...(compose && serviceKey ? { services: serviceKey.split("\n") } : {}),
      },
      fit: "contain" as const,
      noun: "app",
      subject: { kind: "app" as const, relayId: app.relayId, id: app.id },
      title: "App icon",
    }),
    [app.id, app.relayId, compose, serviceKey]
  )
  return (
    <InfoProfile
      icon={<EditableIcon canEdit={canRename} editor={editor} />}
      id={app.id}
      idLabel="app ID"
      name={app.name}
      actions={
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
      {/* Only a Compose file runs more than one container. */}
      {compose ? (
        <InfoFact label="Containers">
          {!available ? (
            <span className="text-muted-foreground">
              {appStatusPresentation(app).label}
            </span>
          ) : app.containers.length === 0 ? (
            <span className="text-muted-foreground">Not deployed</span>
          ) : (
            <span className="flex min-w-0 flex-wrap justify-end gap-1">
              {services.map((service) => (
                <ServiceTag key={service} app={app} service={service} />
              ))}
            </span>
          )}
        </InfoFact>
      ) : null}
    </InfoProfile>
  )
}

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

// What the app runs, the same rows for every kind: where it comes from,
// then what it deploys, an image or a file to open. Configure changes it.
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
  const deploying =
    appRelayAvailable(app) && app.deployment?.state === "running"
  const github = useQuery({
    ...appDeploymentSummaryQueryOptions(app.relayId, app.id),
    enabled: config.sourceType === "github",
    select: (summary) => summary.source,
  })

  return (
    <InfoSection
      icon={<ToyBrick />}
      title="Brick"
      action={
        <>
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
      {config.sourceType === "github" ? (
        <AppGitHubSourceFacts app={app} source={github.data} />
      ) : (
        <>
          <InfoFact label="Type">Standalone Docker</InfoFact>
          {config.sourceType === "image" ? (
            <InfoFact label="Image">
              {config.image ? (
                <InfoCopyValue label="image" value={config.image} />
              ) : (
                <span className="text-muted-foreground">Not set</span>
              )}
            </InfoFact>
          ) : (
            <InfoFact label="Build Strategy">
              <AppDocumentButton
                // Another document closes this one's editor, so a draft
                // can't save into the source that replaced it.
                key={config.sourceType}
                app={app}
                canManage={canManage}
                kind={config.sourceType}
                routeId={routeId}
                saved={config[config.sourceType]}
                size="xs"
              >
                <FileCode2 />
                {appDocuments[config.sourceType].path}
                {config.sourceType === "compose" ? (
                  <span className="text-muted-foreground tabular-nums">
                    {lineCount(config.compose)}
                  </span>
                ) : null}
              </AppDocumentButton>
            </InfoFact>
          )}
        </>
      )}
    </InfoSection>
  )
}

// The repository a GitHub app builds and its branch, then the file in it,
// which opens in the code viewer. Its rows hold their places while it loads.
function AppGitHubSourceFacts({
  app,
  source,
}: {
  app: App
  source: AppGitHubSourceView | null | undefined
}) {
  const loading = <span className="text-muted-foreground">…</span>
  return (
    <>
      <InfoFact label="Type">GitHub App</InfoFact>
      <InfoFact label="Repo">
        {source ? (
          <span className="flex min-w-0 items-center gap-3">
            <a
              className="flex min-w-0 items-center gap-1.5 hover:text-primary-ink"
              href={source.repositoryUrl}
              rel="noreferrer"
              target="_blank"
              title={source.repository}
            >
              <GitHubMark className="size-3.5 shrink-0" />
              <span className="truncate font-mono text-xs">
                {source.repository}
              </span>
            </a>
            <span
              className="flex max-w-[45%] shrink-0 items-center gap-1 text-muted-foreground"
              title={`Deploys from ${source.branch}`}
            >
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate font-mono text-xs">
                {source.branch}
              </span>
            </span>
          </span>
        ) : source === null ? (
          <span className="text-muted-foreground">Not chosen</span>
        ) : (
          loading
        )}
      </InfoFact>
      {source === null ? null : (
        <InfoFact label="Build Strategy">
          {source ? <AppGitHubFileButton app={app} source={source} /> : loading}
        </InfoFact>
      )}
      {source?.connectionId === null ? (
        <InfoFact label="Connection">
          <span className="text-destructive">Removed; choose another</span>
        </InfoFact>
      ) : null}
    </>
  )
}

function AppGitHubFileButton({
  app,
  source,
}: {
  app: App
  source: AppGitHubSourceView
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="min-w-0"
        title={`${source.path} on ${source.branch}`}
        onPointerEnter={warmSyntaxCodeEditorModule}
        onFocus={warmSyntaxCodeEditorModule}
        onClick={() => {
          warmSyntaxCodeEditorModule()
          setOpen(true)
        }}
      >
        <FileCode2 />
        <span className="truncate">{source.path}</span>
      </Button>
      {open ? (
        <AppGitHubFileDialog app={app} source={source} onOpenChange={setOpen} />
      ) : null}
    </>
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
  size = "sm",
}: {
  app: App
  canManage: boolean
  children?: React.ReactNode
  kind: AppDocumentKind
  routeId: string
  saved: string
  size?: "sm" | "xs"
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        type="button"
        size={size}
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

// How the app is reached: the domains Traefik serves, each tagged with the
// service it reaches. The Network page adds and edits them.
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

function lineCount(content: string): string {
  if (!content) return "Empty"
  const lines = content.replace(/\n$/u, "").split("\n").length
  return lines === 1 ? "1 line" : `${lines} lines`
}
