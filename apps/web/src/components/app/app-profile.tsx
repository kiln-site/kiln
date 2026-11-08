import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { appFileRootId, type AppSourceType } from "@workspace/contracts"
import {
  Box,
  FileCode2,
  GitBranch,
  LoaderCircle,
  Settings2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  AppDocumentDialog,
  AppSourceDialog,
  appDocuments,
  type AppDocumentKind,
  type EditableAppConfig,
} from "@/components/app/app-config-dialogs"
import { AppGitHubFileDialog } from "@/components/app/app-github-file-dialog"
import {
  appContainers,
  appRelayAvailable,
  appServices,
  type App,
} from "@/components/app/app-presentation"
import { useAppRunsCompose } from "@/components/app/app-settings"
import { GitHubMark } from "@/components/github-mark"
import { EditableIcon } from "@/components/icon-editor-dialog"
import { InfoCopyValue, InfoFact, InfoFactPair } from "@/components/info-page"
import { InstanceFavoriteToggle } from "@/components/instance-favorite"
import { AppKindIcon } from "@/components/instance-kind-icon"
import { RenameButton } from "@/components/rename-dialog"
import {
  appConfigQueryOptions,
  appDeploymentSummaryQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import type { AppGitHubSourceView } from "@/server/app-deployments.server"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"
import { renameApp } from "@/server/apps"

const APP_NAME_MAX_LENGTH = 120

// What the app is, the same for every kind of instance: on the left its
// icon, name, and Kiln ID with Favorite, and on the right the kind of Brick
// it runs with Configure, split where the facts below split. What its Brick
// deploys follows, the facts that matter to it.
export function AppProfile({
  app,
  canManage,
}: {
  app: App
  // Changes its Brick, which takes its Relay.
  canManage: boolean
}) {
  const brick = useAppBrick(app, canManage)
  const canRename = app.permissions.includes("app.manage")
  const editor = useAppIconEditor(app)
  return (
    <section className="min-w-0 border bg-background/45">
      <div className="@container px-4">
        <div className="grid @lg:grid-cols-2 @lg:gap-x-8">
          <div className="flex min-w-0 items-center gap-4 py-4">
            <EditableIcon canEdit={canRename} editor={editor} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1">
                <h3
                  className="truncate font-heading text-lg font-semibold tracking-[-0.02em]"
                  title={app.name}
                >
                  {app.name}
                </h3>
                {canRename ? <AppRenameButton app={app} /> : null}
              </div>
              <div className="type-meta mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <span className="shrink-0">Kiln ID</span>
                <InfoCopyValue
                  className="text-muted-foreground"
                  label="app ID"
                  value={app.id}
                />
              </div>
            </div>
            <InstanceFavoriteToggle
              id={app.id}
              kind="app"
              name={app.name}
              relayId={app.relayId}
              variant="outline"
            />
          </div>
          {/* The divider sits in the gap, so each half lines up with the
              facts under it. */}
          <div className="flex min-w-0 items-center gap-4 border-t border-border/60 py-4 @lg:-ml-4 @lg:border-t-0 @lg:border-l @lg:pl-4">
            <div className="min-w-0 flex-1">
              <p className="type-technical-label text-muted-foreground/80 light:text-muted-foreground/90">
                Brick
              </p>
              {brick.state === "ready" ? (
                <BrickKind type={brick.type} />
              ) : (
                <p className="mt-1 h-5 text-sm text-muted-foreground">…</p>
              )}
            </div>
            {canManage ? <AppBrickConfigureButton app={app} /> : null}
          </div>
        </div>
      </div>
      <dl className="@container border-t px-4">
        <BrickFacts brick={brick}>
          {(facts) => <FactPairs facts={facts} />}
        </BrickFacts>
      </dl>
    </section>
  )
}

function useAppIconEditor(app: App) {
  const compose = useAppRunsCompose(app)
  const serviceKey = appServices(app).join("\n")
  return React.useMemo(
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
      compact
      id={app.id}
      maxLength={APP_NAME_MAX_LENGTH}
      name={app.name}
      noun="app"
      rename={rename}
    />
  )
}

// Opens the Brick's settings, once they've loaded.
function AppBrickConfigureButton({
  app,
  className,
}: {
  app: App
  className?: string
}) {
  const { data: saved } = useQuery({
    ...appConfigQueryOptions(app.relayId, app.id),
    select: ({ config }) => config,
  })
  const [configuring, setConfiguring] = React.useState(false)
  const deploying =
    appRelayAvailable(app) && app.deployment?.state === "running"
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={className}
        disabled={!saved}
        onClick={() => setConfiguring(true)}
      >
        <Settings2 />
        Configure
      </Button>
      {configuring && saved ? (
        <AppSourceDialog
          app={app}
          deploying={deploying}
          saved={saved}
          onOpenChange={setConfiguring}
        />
      ) : null}
    </>
  )
}

interface BrickFact {
  key: string
  label: string
  value: React.ReactNode
}

type Brick =
  | { state: "loading" }
  | { error: string; state: "error" }
  | {
      facts: ReadonlyArray<BrickFact>
      state: "ready"
      type: AppSourceType
    }

function BrickFacts({
  brick,
  children,
}: {
  brick: Brick
  children: (facts: ReadonlyArray<BrickFact>) => React.ReactNode
}) {
  if (brick.state === "error") {
    return <p className="py-3 text-xs text-destructive">{brick.error}</p>
  }
  if (brick.state === "loading") {
    return (
      <div className="grid h-20 place-items-center">
        <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
      </div>
    )
  }
  return children(brick.facts)
}

// Facts two to a row when there's room; an odd one out takes the row.
function FactPairs({ facts }: { facts: ReadonlyArray<BrickFact> }) {
  const rows: Array<ReadonlyArray<BrickFact>> = []
  for (let index = 0; index < facts.length; index += 2) {
    rows.push(facts.slice(index, index + 2))
  }
  return rows.map((row) =>
    row.length === 2 ? (
      <InfoFactPair key={row.map((fact) => fact.key).join("+")}>
        {row.map((fact) => (
          <InfoFact key={fact.key} label={fact.label}>
            {fact.value}
          </InfoFact>
        ))}
      </InfoFactPair>
    ) : (
      row.map((fact) => (
        <InfoFact key={fact.key} label={fact.label}>
          {fact.value}
        </InfoFact>
      ))
    )
  )
}

// GitHub or Docker, as Add App offers them.
function BrickKind({ type }: { type: AppSourceType }) {
  const github = type === "github"
  return (
    <p className="mt-1 flex h-5 items-center gap-1.5 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
      {github ? <GitHubMark /> : <Box />}
      {github ? "GitHub" : "Docker"}
    </p>
  )
}

const muted = (text: string) => (
  <span className="text-muted-foreground">{text}</span>
)

// The app's Brick as facts, each kind with those that matter to it: where
// it comes from, then what it builds or pulls.
function useAppBrick(app: App, canManage: boolean): Brick {
  const config = useQuery(appConfigQueryOptions(app.relayId, app.id))
  const saved = config.data?.config
  const { data: source } = useQuery({
    ...appDeploymentSummaryQueryOptions(app.relayId, app.id),
    enabled: saved?.sourceType === "github",
    select: (summary) => summary.source,
  })
  if (config.isError) return { error: config.error.message, state: "error" }
  if (!saved) return { state: "loading" }
  return {
    facts:
      saved.sourceType === "github"
        ? githubFacts(app, source)
        : dockerFacts(app, canManage, saved),
    state: "ready",
    type: saved.sourceType,
  }
}

function dockerFacts(
  app: App,
  canManage: boolean,
  config: EditableAppConfig
): ReadonlyArray<BrickFact> {
  const command: BrickFact = {
    key: "command",
    label: "Start command",
    value: config.command.trim() ? (
      <InfoCopyValue label="start command" value={config.command.trim()} />
    ) : (
      muted("Image default")
    ),
  }
  if (config.sourceType === "image") {
    return [
      { key: "type", label: "Type", value: "Image" },
      {
        key: "registry",
        label: "Registry",
        value: config.image ? imageRegistry(config.image) : muted("—"),
      },
      {
        key: "image",
        label: "Image",
        value: config.image ? (
          <InfoCopyValue label="image" value={config.image} />
        ) : (
          muted("Not set")
        ),
      },
      command,
    ]
  }
  // GitHub apps have their own facts, so what's left is a file in Kiln.
  const kind = config.sourceType === "compose" ? "compose" : "dockerfile"
  const file = (
    <AppDocumentButton
      // Another document closes this one's editor, so a draft can't save
      // into the source that replaced it.
      key={kind}
      app={app}
      canManage={canManage}
      kind={kind}
      saved={config[kind]}
    >
      <FileCode2 />
      {appDocuments[kind].path}
      <span className="text-muted-foreground tabular-nums">
        {lineCount(config[kind])}
      </span>
    </AppDocumentButton>
  )
  if (kind === "dockerfile") {
    const bases = baseImages(config.dockerfile)
    return [
      { key: "type", label: "Type", value: "Dockerfile" },
      {
        key: "base",
        label: "Base image",
        value:
          bases.length > 0 ? (
            <span
              className="truncate font-mono text-xs"
              title={bases.join("\n")}
            >
              {bases.at(-1)}
              {bases.length > 1 ? (
                <span className="text-muted-foreground">
                  {` +${bases.length - 1} stage${bases.length > 2 ? "s" : ""}`}
                </span>
              ) : null}
            </span>
          ) : (
            muted("—")
          ),
      },
      { key: "file", label: "Build file", value: file },
      command,
    ]
  }
  // Each service by its newest container, as the Containers tabs show it.
  const services = appServices(app)
  const containers = appContainers(app)
  const running = services.filter(
    (service) =>
      containers.find((container) => container.service === service)?.running
  ).length
  const images = [...new Set(app.containers.map(({ image }) => image))]
  return [
    { key: "type", label: "Type", value: "Compose" },
    { key: "file", label: "Compose file", value: file },
    {
      key: "services",
      label: "Services",
      value:
        services.length > 0 ? (
          <span className="tabular-nums" title={services.join("\n")}>
            {running} of {services.length} running
          </span>
        ) : (
          muted("Not deployed")
        ),
    },
    {
      key: "images",
      label: "Images",
      value:
        images.length > 0 ? (
          <span className="tabular-nums" title={images.join("\n")}>
            {images.length}
          </span>
        ) : (
          muted("—")
        ),
    },
  ]
}

// The repository a GitHub app builds, its branch and the file it builds,
// which opens in the code viewer, and how it deploys. Its rows hold their
// places while it loads.
function githubFacts(
  app: App,
  source: AppGitHubSourceView | null | undefined
): ReadonlyArray<BrickFact> {
  const pending = source === undefined ? muted("…") : muted("—")
  return [
    {
      key: "type",
      label: "Type",
      value: source
        ? source.build === "compose"
          ? "Compose"
          : "Dockerfile"
        : pending,
    },
    {
      key: "repository",
      label: "Repository",
      value: source ? (
        <a
          className="truncate font-mono text-xs hover:text-primary-ink"
          href={source.repositoryUrl}
          rel="noreferrer"
          target="_blank"
          title={source.repository}
        >
          {source.repository}
        </a>
      ) : source === null ? (
        muted("Not chosen")
      ) : (
        pending
      ),
    },
    {
      key: "branch",
      label: "Branch",
      value: source ? (
        <span className="flex min-w-0 items-center gap-1">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs">{source.branch}</span>
        </span>
      ) : (
        pending
      ),
    },
    {
      key: "file",
      label: source?.build === "compose" ? "Compose file" : "Build file",
      value: source ? (
        <AppGitHubFileButton app={app} source={source} />
      ) : (
        pending
      ),
    },
    {
      key: "push",
      label: "Deploy on push",
      value: source ? (source.autoDeploy ? "On" : muted("Off")) : pending,
    },
    {
      key: "connection",
      label: "Connection",
      value: source ? (
        source.connectionId === null ? (
          <span className="text-destructive">Removed; choose another</span>
        ) : (
          <span className="truncate">
            {source.connectionName ?? "Another member's"}
          </span>
        )
      ) : (
        pending
      ),
    },
  ]
}

// Where an image is pulled from: the host before its first slash, when it
// names one, or Docker Hub.
function imageRegistry(image: string): string {
  const [first, ...rest] = image.split("/")
  return rest.length > 0 &&
    first !== undefined &&
    (first.includes(".") || first.includes(":") || first === "localhost")
    ? first
    : "Docker Hub"
}

// The images a Dockerfile's stages start from, the last being what runs. A
// stage built on an earlier one ("FROM build") counts as that one's image.
function baseImages(dockerfile: string): ReadonlyArray<string> {
  const stages = new Map<string, string>()
  const images: Array<string> = []
  for (const match of dockerfile.matchAll(
    /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/gimu
  )) {
    const from = match[1]
    if (!from) continue
    const image = stages.get(from.toLowerCase()) ?? from
    if (match[2]) stages.set(match[2].toLowerCase(), image)
    images.push(image)
  }
  return images
}

function lineCount(content: string): string {
  if (!content) return "Empty"
  const lines = content.replace(/\n$/u, "").split("\n").length
  return lines === 1 ? "1 line" : `${lines} lines`
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

// Opens a Dockerfile or Compose file in the code dialog, to edit for those
// who manage the app and to read for everyone else.
function AppDocumentButton({
  app,
  canManage,
  children,
  kind,
  saved,
}: {
  app: App
  canManage: boolean
  children: React.ReactNode
  kind: AppDocumentKind
  saved: string
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        onPointerEnter={warmSyntaxCodeEditorModule}
        onFocus={warmSyntaxCodeEditorModule}
        onClick={() => {
          warmSyntaxCodeEditorModule()
          setOpen(true)
        }}
      >
        {children}
      </Button>
      {open ? (
        <AppDocumentDialog
          app={app}
          canManage={canManage}
          deploying={app.deployment?.state === "running"}
          kind={kind}
          saved={saved}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
}
