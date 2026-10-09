import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import type { AppConfig, AppSourceType } from "@workspace/contracts"
import {
  Box,
  CalendarClock,
  ChevronDown,
  Container,
  Eye,
  EyeOff,
  FileCode2,
  LoaderCircle,
  Pencil,
  Rocket,
  ScrollText,
  Settings2,
  Tags,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import {
  appRelayAvailable,
  showAppOperationError,
  sourceTypeLabels,
  type App,
} from "@/components/app/app-presentation"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
import { CodeDocumentPanel } from "@/components/code-document-panel"
import { InfoCard, InfoCardHeader, MetaRow } from "@/components/info-card"
import { RelativeTime } from "@/components/relative-time"
import { appConfigQueryOptions, queryKeys } from "@/lib/query-options"
import {
  loadSyntaxCodeEditorModule,
  warmSyntaxCodeEditorModule,
} from "@/lib/syntax-editor-module-preload"
import { deployApp, updateAppConfig } from "@/server/apps"

const SyntaxCodeEditor = React.lazy(async () => {
  const module = await loadSyntaxCodeEditorModule()
  return { default: module.SyntaxCodeEditor }
})

type EditableConfig = Omit<AppConfig, "databaseIds">

// What the app runs and how: its source, runtime, latest deployment, and
// containers. The app's default page.
export function AppOverviewPage() {
  const { app } = useAppWorkspace()
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
                canManage={
                  app.permissions.includes("app.manage") &&
                  appRelayAvailable(app)
                }
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
          <AppDeploymentCard
            app={app}
            canReadLogs={app.permissions.includes("app.logs.read")}
          />
        </div>

        <AppContainersCard app={app} />
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
    mutationFn: async ({
      next,
      override,
    }: {
      next: "deploy" | "stay"
      // A source edited in its dialog, saved along with the rest.
      override?: Partial<EditableConfig>
    }) => {
      const result = await updateAppConfig({
        data: {
          appId: app.id,
          config: { ...draft, ...override },
          relayId: app.relayId,
        },
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
  const deploying = app.deployment?.state === "running"

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
          ) : (
            <SourceDocument
              canManage={canManage}
              deploying={deploying || save.isPending}
              kind={draft.sourceType}
              saved={
                draft.sourceType === "dockerfile"
                  ? saved.dockerfile
                  : saved.compose
              }
              value={
                draft.sourceType === "dockerfile"
                  ? draft.dockerfile
                  : draft.compose
              }
              onSave={(content, next) =>
                save.mutateAsync({
                  next,
                  override:
                    draft.sourceType === "dockerfile"
                      ? { dockerfile: content }
                      : { compose: content },
                })
              }
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
            onClick={() => save.mutate({ next: "stay" })}
          >
            {save.isPending && save.variables.next === "stay" ? (
              <LoaderCircle className="animate-spin" />
            ) : null}
            Save
          </Button>
          <Button
            disabled={save.isPending || deploying}
            size="sm"
            type="button"
            onClick={() => save.mutate({ next: "deploy" })}
          >
            {save.isPending && save.variables.next === "deploy" ? (
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

const sourceDocuments = {
  compose: {
    hint: "Services reach each other by name. Mount the app’s data with ${KILN_DATA}, for example ${KILN_DATA}/db:/var/lib/postgresql/data.",
    noun: "Compose file",
    path: "compose.yaml",
    placeholder:
      "services:\n  web:\n    image: nginx:latest\n    ports:\n      - 8080:80",
  },
  dockerfile: {
    hint: "Built on the Relay with the app’s files as its context, so COPY can use anything uploaded to Files.",
    noun: "Dockerfile",
    path: "Dockerfile",
    placeholder:
      'FROM node:24-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "server.js"]',
  },
} as const

// A Dockerfile or Compose file: a preview here, edited in its own dialog.
const SourceDocument = React.memo(function SourceDocument({
  canManage,
  deploying,
  kind,
  onSave,
  saved,
  value,
}: {
  canManage: boolean
  deploying: boolean
  kind: "compose" | "dockerfile"
  onSave: (content: string, next: "deploy" | "stay") => Promise<unknown>
  saved: string
  value: string
}) {
  const [open, setOpen] = React.useState(false)
  const document = sourceDocuments[kind]
  const lines = value ? value.split("\n") : []
  const openEditor = () => {
    warmSyntaxCodeEditorModule()
    setOpen(true)
  }

  return (
    <div>
      <button
        type="button"
        className="group block w-full overflow-hidden rounded-lg border bg-background/70 text-left transition-colors hover:border-primary/40"
        onClick={openEditor}
      >
        <span className="flex items-center gap-2 border-b px-3 py-2">
          <FileCode2 className="size-4 text-primary" />
          <span className="font-mono text-xs">{document.path}</span>
          <span className="type-meta text-muted-foreground">
            {lines.length === 0
              ? "Empty"
              : `${lines.length} line${lines.length === 1 ? "" : "s"}`}
            {value !== saved ? " · unsaved" : ""}
          </span>
          <span className="type-control-sm ml-auto flex items-center gap-1 text-muted-foreground group-hover:text-primary">
            {canManage ? (
              <Pencil className="size-3.5" />
            ) : (
              <Eye className="size-3.5" />
            )}
            {canManage ? "Edit" : "View"}
          </span>
        </span>
        <pre className="max-h-48 overflow-hidden px-3 py-2.5 font-mono text-[12px] leading-relaxed text-muted-foreground">
          {lines.length > 0
            ? lines.slice(0, 10).join("\n")
            : document.placeholder}
        </pre>
      </button>
      <p className="type-meta mt-2 text-muted-foreground">{document.hint}</p>
      {open ? (
        <SourceDocumentDialog
          canManage={canManage}
          deploying={deploying}
          kind={kind}
          saved={saved}
          value={value}
          onOpenChange={setOpen}
          onSave={onSave}
        />
      ) : null}
    </div>
  )
})

function SourceDocumentDialog({
  canManage,
  deploying,
  kind,
  onOpenChange,
  onSave,
  saved,
  value,
}: {
  canManage: boolean
  deploying: boolean
  kind: "compose" | "dockerfile"
  onOpenChange: (open: boolean) => void
  onSave: (content: string, next: "deploy" | "stay") => Promise<unknown>
  saved: string
  value: string
}) {
  const document = sourceDocuments[kind]
  const [draft, setDraft] = React.useState(value)
  const [saving, setSaving] = React.useState<"deploy" | "stay" | null>(null)
  const save = async (next: "deploy" | "stay") => {
    setSaving(next)
    // The page's own save reports failures; the dialog stays open for them.
    await onSave(draft, next).then(
      () => onOpenChange(false),
      () => setSaving(null)
    )
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="sr-only">
          <DialogTitle>{document.noun}</DialogTitle>
          <DialogDescription>{document.hint}</DialogDescription>
        </DialogHeader>
        <CodeDocumentPanel
          actions={
            canManage ? (
              <>
                <Button
                  disabled={saving !== null || draft === saved}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => void save("stay")}
                >
                  {saving === "stay" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : null}
                  Save
                </Button>
                <Button
                  disabled={saving !== null || deploying}
                  size="sm"
                  type="button"
                  onClick={() => void save("deploy")}
                >
                  {saving === "deploy" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Rocket />
                  )}
                  Save and deploy
                </Button>
              </>
            ) : null
          }
          content={draft}
          edit={
            canManage
              ? {
                  original: saved,
                  placeholder: document.placeholder,
                  onChange: setDraft,
                }
              : undefined
          }
          languagePath={document.path}
          noun={document.noun}
          title={document.path}
        />
      </DialogContent>
    </Dialog>
  )
}

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

function editable(config: AppConfig): EditableConfig {
  const { databaseIds: _databaseIds, ...rest } = config
  return rest
}

function noop() {}
