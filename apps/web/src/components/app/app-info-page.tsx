import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import type { AppConfig, AppSourceType } from "@workspace/contracts"
import {
  Box,
  Boxes,
  CalendarClock,
  ChevronDown,
  Container,
  Eye,
  EyeOff,
  FileCode2,
  Fingerprint,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  Network,
  Rocket,
  ScrollText,
  Settings2,
  Tags,
  Trash2,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import { DeleteAppDialog } from "@/components/app/app-dialogs"
import {
  appRelayAvailable,
  appStatusPresentation,
  showAppOperationError,
  sourceTypeLabels,
  type App,
} from "@/components/app/app-presentation"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
import {
  CopyMetaRow,
  DangerZone,
  InfoCard,
  InfoCardHeader,
  MetaRow,
} from "@/components/info-card"
import { InstanceFavoriteButton } from "@/components/instance-favorite"
import { RelativeTime } from "@/components/relative-time"
import { StatusIndicator } from "@/components/status-indicator"
import { appConfigQueryOptions, queryKeys } from "@/lib/query-options"
import { loadSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"
import { deployApp, updateAppConfig } from "@/server/apps"

const SyntaxCodeEditor = React.lazy(async () => {
  const module = await loadSyntaxCodeEditorModule()
  return { default: module.SyntaxCodeEditor }
})

const createdAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

type EditableConfig = Omit<AppConfig, "databaseIds">

export function AppInfoPage() {
  const { app } = useAppWorkspace()
  const can = (permission: App["permissions"][number]) =>
    app.permissions.includes(permission)
  const config = useQuery(appConfigQueryOptions(app.relayId, app.id))

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto max-w-6xl px-5 py-6 sm:px-8 sm:py-8">
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            {config.data ? (
              <AppConfigForm
                // A fresh form for each saved configuration.
                key={config.dataUpdatedAt}
                app={app}
                canManage={can("app.manage") && appRelayAvailable(app)}
                environmentHidden={config.data.environmentHidden}
                saved={config.data.config}
              />
            ) : (
              <InfoCard>
                <InfoCardHeader icon={<FileCode2 />} title="Source" />
                <div className="grid h-48 place-items-center">
                  {config.isError ? (
                    <p className="text-xs text-destructive">
                      {config.error.message}
                    </p>
                  ) : (
                    <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                  )}
                </div>
              </InfoCard>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <AppIdentityCard app={app} />
            <AppDeploymentCard app={app} canReadLogs={can("app.logs.read")} />
          </div>
        </div>

        <AppContainersCard app={app} />

        {can("app.delete") ? <AppDangerZone app={app} /> : null}
      </div>
    </section>
  )
}

function AppConfigForm({
  app,
  canManage,
  environmentHidden,
  saved,
}: {
  app: App
  canManage: boolean
  environmentHidden: boolean
  saved: AppConfig
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { routeId } = useAppWorkspace()
  const [draft, setDraft] = React.useState<EditableConfig>(() =>
    editable(saved)
  )
  const dirty = React.useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(editable(saved)),
    [draft, saved]
  )
  const update = React.useCallback(
    <K extends keyof EditableConfig>(key: K, value: EditableConfig[K]) =>
      setDraft((current) => ({ ...current, [key]: value })),
    []
  )
  const save = useMutation({
    mutationFn: async (next: "deploy" | "stay") => {
      const result = await updateAppConfig({
        data: { appId: app.id, config: draft, relayId: app.relayId },
      })
      if (next === "deploy") {
        await deployApp({ data: { appId: app.id, relayId: app.relayId } })
      }
      return { config: result.config, next }
    },
    onSuccess: async ({ config, next }) => {
      queryClient.setQueryData(
        queryKeys.apps.config(app.relayId, app.id),
        (current: { environmentHidden: boolean } | undefined) => ({
          config,
          environmentHidden: current?.environmentHidden ?? false,
        })
      )
      await queryClient.invalidateQueries({ queryKey: queryKeys.apps.list })
      if (next === "deploy" && app.permissions.includes("app.logs.read")) {
        await navigate({
          params: { appId: routeId },
          search: { stream: "deployment" },
          to: "/app/$appId/logs",
        })
        return
      }
      showToast({ message: "Configuration saved", type: "success" })
    },
    onError: (error) => showAppOperationError("Could not save", error),
  })
  const singleContainer = draft.sourceType !== "compose"

  return (
    <>
      <InfoCard>
        <InfoCardHeader
          icon={<FileCode2 />}
          title="Source"
          action={
            <SourceTypeSwitch
              disabled={!canManage}
              value={draft.sourceType}
              onChange={(sourceType) => update("sourceType", sourceType)}
            />
          }
        />
        <div className="p-4">
          {draft.sourceType === "image" ? (
            <label className="block">
              <span className="type-technical-label mb-2 block text-muted-foreground">
                Image and tag
              </span>
              <Input
                className="font-mono"
                disabled={!canManage}
                placeholder="nginx:latest"
                spellCheck={false}
                value={draft.image}
                onChange={(event) => update("image", event.currentTarget.value)}
              />
              <span className="type-meta mt-2 block text-muted-foreground">
                Pulled on every deploy from Docker Hub or any registry the Relay
                can reach.
              </span>
            </label>
          ) : draft.sourceType === "dockerfile" ? (
            <SourceEditor
              ariaLabel="Dockerfile"
              disabled={!canManage}
              hint="Built on the Relay with the app’s files as its context, so COPY can use anything uploaded to Files."
              path="Dockerfile"
              placeholder={
                'FROM node:24-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "server.js"]'
              }
              saved={saved.dockerfile}
              value={draft.dockerfile}
              onChange={(value) => update("dockerfile", value)}
            />
          ) : (
            <SourceEditor
              ariaLabel="Compose file"
              disabled={!canManage}
              hint="Services reach each other by name. Mount the app’s data with ${KILN_DATA}, for example ${KILN_DATA}/db:/var/lib/postgresql/data."
              path="compose.yaml"
              placeholder={
                "services:\n  web:\n    image: nginx:latest\n    ports:\n      - 8080:80"
              }
              saved={saved.compose}
              value={draft.compose}
              onChange={(value) => update("compose", value)}
            />
          )}
        </div>
      </InfoCard>

      <InfoCard>
        <InfoCardHeader icon={<Settings2 />} title="Runtime" />
        <div className="space-y-4 p-4">
          {singleContainer ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="type-technical-label mb-2 block text-muted-foreground">
                  Start command
                </span>
                <Input
                  className="font-mono"
                  disabled={!canManage}
                  placeholder="Image default"
                  spellCheck={false}
                  value={draft.command}
                  onChange={(event) =>
                    update("command", event.currentTarget.value)
                  }
                />
              </label>
              <label className="block">
                <span className="type-technical-label mb-2 block text-muted-foreground">
                  Data mount path
                </span>
                <Input
                  className="font-mono"
                  disabled={!canManage}
                  placeholder="/data"
                  spellCheck={false}
                  value={draft.dataMount}
                  onChange={(event) =>
                    update("dataMount", event.currentTarget.value)
                  }
                />
              </label>
            </div>
          ) : null}
          <EnvironmentEditor
            disabled={!canManage}
            hidden={environmentHidden}
            saved={saved.environment}
            sourceType={draft.sourceType}
            value={draft.environment}
            onChange={(value) => update("environment", value)}
          />
        </div>
      </InfoCard>

      {canManage && dirty ? (
        <div className="sticky bottom-4 z-10 flex items-center gap-2 rounded-xl border bg-popover/95 px-4 py-2.5 shadow-lg backdrop-blur">
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            Unsaved changes. They apply on the next deploy.
          </span>
          <Button
            disabled={save.isPending}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => setDraft(editable(saved))}
          >
            Discard
          </Button>
          <Button
            disabled={save.isPending}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => save.mutate("stay")}
          >
            {save.isPending && save.variables === "stay" ? (
              <LoaderCircle className="animate-spin" />
            ) : null}
            Save
          </Button>
          <Button
            disabled={save.isPending || app.deployment?.state === "running"}
            size="sm"
            type="button"
            onClick={() => save.mutate("deploy")}
          >
            {save.isPending && save.variables === "deploy" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Rocket />
            )}
            Save and deploy
          </Button>
        </div>
      ) : null}
    </>
  )
}

const sourceTypes: ReadonlyArray<AppSourceType> = [
  "image",
  "dockerfile",
  "compose",
]

function SourceTypeSwitch({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean
  onChange: (value: AppSourceType) => void
  value: AppSourceType
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Source"
      className="flex rounded-lg border bg-background/60 p-0.5"
    >
      {sourceTypes.map((type) => (
        <button
          key={type}
          role="radio"
          aria-checked={value === type}
          disabled={disabled}
          type="button"
          className={cn(
            "type-control-sm rounded-md px-2.5 py-1 transition-colors disabled:cursor-default",
            value === type
              ? "bg-primary/15 text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => onChange(type)}
        >
          {sourceTypeLabels[type]}
        </button>
      ))}
    </div>
  )
}

const SourceEditor = React.memo(function SourceEditor({
  ariaLabel,
  disabled,
  hint,
  onChange,
  path,
  placeholder,
  saved,
  value,
}: {
  ariaLabel: string
  disabled: boolean
  hint: string
  onChange: (value: string) => void
  path: string
  placeholder: string
  saved: string
  value: string
}) {
  return (
    <div>
      <div className="h-[22rem] overflow-hidden rounded-lg border bg-background/70">
        <React.Suspense
          fallback={<div className="h-full animate-pulse bg-muted/15" />}
        >
          <SyntaxCodeEditor
            ariaLabel={ariaLabel}
            disabled={disabled}
            fontSize={13}
            originalValue={saved}
            path={path}
            placeholder={placeholder}
            readOnly={disabled}
            redactSensitive={false}
            searchOpen={false}
            searchQuery=""
            showChanges={false}
            value={value}
            wrapLines={false}
            onChange={onChange}
            onSearchOpenChange={noop}
          />
        </React.Suspense>
      </div>
      <p className="type-meta mt-2 text-muted-foreground">{hint}</p>
    </div>
  )
})

function EnvironmentEditor({
  disabled,
  hidden,
  onChange,
  saved,
  sourceType,
  value,
}: {
  disabled: boolean
  hidden: boolean
  onChange: (value: string) => void
  saved: string
  sourceType: AppSourceType
  value: string
}) {
  const [revealed, setRevealed] = React.useState(false)
  const count = value
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#")).length
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="type-technical-label flex-1 text-muted-foreground">
          Environment
        </span>
        {hidden ? null : (
          <Button
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? <EyeOff /> : <Eye />}
            {revealed ? "Hide" : count > 0 ? `Show ${count}` : "Edit"}
          </Button>
        )}
      </div>
      {hidden ? (
        <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
          Only people who can configure this app see its environment.
        </p>
      ) : revealed ? (
        <div className="h-48 overflow-hidden rounded-lg border bg-background/70">
          <React.Suspense
            fallback={<div className="h-full animate-pulse bg-muted/15" />}
          >
            <SyntaxCodeEditor
              ariaLabel="Environment"
              disabled={disabled}
              fontSize={13}
              originalValue={saved}
              path=".env"
              placeholder={"DATABASE_URL=postgres://…\nNODE_ENV=production"}
              readOnly={disabled}
              redactSensitive={false}
              searchOpen={false}
              searchQuery=""
              showChanges={false}
              value={value}
              wrapLines={false}
              onChange={onChange}
              onSearchOpenChange={noop}
            />
          </React.Suspense>
        </div>
      ) : (
        <button
          type="button"
          className="w-full rounded-lg border border-dashed px-3 py-3 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/20"
          onClick={() => setRevealed(true)}
        >
          {count > 0
            ? `${count} variable${count === 1 ? "" : "s"}, hidden`
            : "No variables"}
        </button>
      )}
      <p className="type-meta mt-2 text-muted-foreground">
        {sourceType === "compose"
          ? "KEY=VALUE lines, available to the Compose file as ${KEY}."
          : "KEY=VALUE lines, passed to the container."}
      </p>
    </div>
  )
}

function AppIdentityCard({ app }: { app: App }) {
  return (
    <InfoCard>
      <InfoCardHeader
        icon={<Fingerprint />}
        title="Identity"
        action={
          <div className="flex items-center gap-2">
            <StatusIndicator status={appStatusPresentation(app)} />
            <InstanceFavoriteButton
              id={app.id}
              kind="app"
              relayId={app.relayId}
            />
          </div>
        }
      />
      <MetaRow icon={Boxes} label="Name" value={app.name} />
      <MetaRow
        icon={Fingerprint}
        label="App full ID"
        value={app.id}
        mono
        wrap
      />
      <MetaRow
        icon={HardDrive}
        label="Relay"
        value={`${app.relayName} · ${app.relayId}`}
      />
      <CopyMetaRow
        icon={Network}
        label="Internal address"
        value={app.hostname}
      />
      {app.dataDirectory ? (
        <CopyMetaRow
          icon={FolderOpen}
          label="Data directory"
          value={app.dataDirectory}
        />
      ) : null}
      <MetaRow
        icon={CalendarClock}
        label="Created"
        value={createdAtFormatter.format(new Date(app.createdAt))}
      />
    </InfoCard>
  )
}

function AppDeploymentCard({
  app,
  canReadLogs,
}: {
  app: App
  canReadLogs: boolean
}) {
  const { routeId } = useAppWorkspace()
  const deployment = app.deployment
  return (
    <InfoCard>
      <InfoCardHeader
        icon={<Rocket />}
        title="Latest deployment"
        action={
          canReadLogs ? (
            <Button asChild size="xs" variant="ghost">
              <Link
                params={{ appId: routeId }}
                search={{ stream: "deployment" }}
                to="/app/$appId/logs"
              >
                <ScrollText />
                Logs
              </Link>
            </Button>
          ) : null
        }
      />
      {deployment ? (
        <>
          <MetaRow
            icon={Rocket}
            label="Deployment"
            value={`${deployment.id} · ${sourceTypeLabels[deployment.sourceType]}`}
            mono
          />
          <div className="flex min-h-14 items-center gap-3 border-b px-4 py-3 last:border-b-0">
            <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="type-technical-label block text-muted-foreground">
                {deployment.state === "running" ? "Started" : "Finished"}
              </span>
              <span className="mt-0.5 block text-xs font-medium">
                <RelativeTime
                  timestamp={Date.parse(
                    deployment.finishedAt ?? deployment.startedAt
                  )}
                />
              </span>
            </span>
            <Badge
              variant="outline"
              className={cn(
                "type-meta uppercase",
                deployment.state === "failed"
                  ? "border-destructive/40 text-destructive"
                  : deployment.state === "running"
                    ? "border-blue-500/40 text-blue-300"
                    : "border-emerald-500/40 text-emerald-300"
              )}
            >
              {deployment.state === "running"
                ? "Deploying"
                : deployment.state === "failed"
                  ? "Failed"
                  : "Deployed"}
            </Badge>
          </div>
          {deployment.error ? (
            <p className="border-b px-4 py-3 font-mono text-xs break-words text-destructive last:border-b-0">
              {deployment.error}
            </p>
          ) : null}
        </>
      ) : (
        <p className="px-4 py-5 text-xs text-muted-foreground">
          {app.containers.length > 0
            ? "Deployed before the Relay last restarted."
            : "Not deployed yet. Choose a source, then deploy."}
        </p>
      )}
    </InfoCard>
  )
}

function AppContainersCard({ app }: { app: App }) {
  return (
    <InfoCard className="mt-4">
      <InfoCardHeader
        icon={<Container />}
        title="Containers"
        action={
          <span className="type-meta text-muted-foreground">
            {app.containers.length === 0
              ? "None yet"
              : `${app.containers.filter((container) => container.running).length} of ${app.containers.length} running`}
          </span>
        }
      />
      {app.containers.length === 0 ? (
        <p className="px-4 py-5 text-xs text-muted-foreground">
          Containers appear here once the app is deployed.
        </p>
      ) : (
        <ul>
          {app.containers.map((container) => (
            <ContainerRow key={container.id} container={container} />
          ))}
        </ul>
      )}
    </InfoCard>
  )
}

const ContainerRow = React.memo(function ContainerRow({
  container,
}: {
  container: App["containers"][number]
}) {
  const [labelsOpen, setLabelsOpen] = React.useState(false)
  const labels = Object.entries(container.labels).sort(([left], [right]) =>
    left.localeCompare(right)
  )
  return (
    <li className="border-b last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full",
            container.running ? "bg-emerald-400" : "bg-muted-foreground/40"
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-sm font-medium">{container.service}</span>
            <span className="type-meta truncate font-mono text-muted-foreground">
              {container.name}
            </span>
          </span>
          <span className="type-meta mt-0.5 flex flex-wrap gap-x-3 font-mono text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Box className="size-3" />
              {container.image}
            </span>
            <span>{container.status}</span>
            {container.ports.map((port) => (
              <span key={`${port.hostPort}/${port.protocol}`}>
                {port.hostPort}→{port.containerPort}/{port.protocol}
              </span>
            ))}
          </span>
        </span>
        <Button
          aria-expanded={labelsOpen}
          size="xs"
          type="button"
          variant="ghost"
          onClick={() => setLabelsOpen((open) => !open)}
        >
          <Tags />
          Labels
          <ChevronDown
            className={cn("transition-transform", labelsOpen && "rotate-180")}
          />
        </Button>
      </div>
      {labelsOpen ? (
        <dl className="grid gap-x-4 gap-y-1 border-t bg-background/40 px-4 py-3 font-mono text-[11px] sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
          {labels.map(([key, value]) => (
            <React.Fragment key={key}>
              <dt className="truncate text-muted-foreground" title={key}>
                {key}
              </dt>
              <dd className="break-all">{value || "—"}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
    </li>
  )
})

function AppDangerZone({ app }: { app: App }) {
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <DangerZone
        title="Delete app"
        detail={app.dataDirectory || app.id}
        action={
          <Button
            type="button"
            variant="destructive"
            onClick={() => setOpen(true)}
          >
            <Trash2 />
            Delete
          </Button>
        }
      />
      {open ? (
        <DeleteAppDialog
          app={app}
          open
          onDeleted={() => void navigate({ to: "/infra/apps" })}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
}

function editable(config: AppConfig): EditableConfig {
  const { databaseIds: _databaseIds, ...rest } = config
  return rest
}

function noop() {}
