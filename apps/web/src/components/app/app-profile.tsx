import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { appFileRootId, type AppBrickDeployType } from "@workspace/contracts"
import {
  Box,
  FileCode2,
  GitBranch,
  Layers,
  LoaderCircle,
  Settings2,
  Unlink,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"

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
  carriedBy,
  type App,
} from "@/components/app/app-presentation"
import { useAppRunsCompose } from "@/components/app/app-settings"
import { GitHubMark } from "@/components/github-mark"
import { EditableIcon } from "@/components/icon-editor-dialog"
import { InfoCopyValue, InfoFact, InfoFactPair } from "@/components/info-page"
import { InstanceFavoriteToggle } from "@/components/instance-favorite"
import {
  InstanceProfile,
  InstanceProfileBrick,
} from "@/components/instance-profile"
import { AppKindIcon } from "@/components/instance-kind-icon"
import { RenameButton } from "@/components/rename-dialog"
import {
  appConfigQueryOptions,
  appDeploymentSummaryQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import type { AppGitHubSourceView } from "@/server/app-deployments.server"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"
import { detachAppBrick, renameApp } from "@/server/apps"

const APP_NAME_MAX_LENGTH = 120

// What the app is, in the profile every kind of instance has: the kind of
// Brick it runs with Configure, then what that Brick deploys.
export function AppProfile({
  app,
  canManage,
}: {
  app: App
  // Changes its Brick, which takes its Relay.
  canManage: boolean
}) {
  const brick = useAppBrick(app, canManage)
  const follows = brick.state === "ready" ? brick.follows : undefined
  const canRename = app.permissions.includes("app.manage")
  const editor = useAppIconEditor(app)
  return (
    <InstanceProfile
      brick={
        brick.state === "ready" ? (
          <AppBrickName deploys={brick.deploys} follows={brick.follows} />
        ) : (
          <p className="mt-1 h-5 text-sm text-muted-foreground">…</p>
        )
      }
      brickAction={
        !canManage ? null : follows === undefined ? (
          <AppBrickConfigureButton app={app} />
        ) : (
          // What it deploys is its Brick's to say while it follows one.
          <AppBrickDetachButton app={app} brick={follows} />
        )
      }
      favorite={
        <InstanceFavoriteToggle
          id={app.id}
          kind="app"
          name={app.name}
          relayId={app.relayId}
          variant="outline"
        />
      }
      icon={<EditableIcon canEdit={canRename} editor={editor} />}
      id={app.id}
      idLabel="app ID"
      name={app.name}
      rename={canRename ? <AppRenameButton app={app} /> : null}
    >
      <BrickFacts brick={brick}>
        {(facts) => <FactPairs facts={facts} />}
      </BrickFacts>
    </InstanceProfile>
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

// Stops the App following its Brick, once that is confirmed: it can't be
// undone.
function AppBrickDetachButton({ app, brick }: { app: App; brick: string }) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = React.useState(false)
  const detach = useMutation({
    mutationFn: () =>
      detachAppBrick({ data: { appId: app.id, relayId: app.relayId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.apps.config(app.relayId, app.id),
      })
      showToast({
        message: `${app.name} detached from ${brick}`,
        type: "success",
      })
      setConfirming(false)
    },
  })
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setConfirming(true)}
      >
        <Unlink />
        Detach
      </Button>
      {confirming ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!detach.isPending) setConfirming(open)
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                Detach {app.name} from {brick}?
              </DialogTitle>
              <DialogDescription>
                It keeps running as it is, and what {brick} set becomes yours to
                change: its image, its start command and its variables. It is no
                longer offered {brick}&apos;s updates, and can&apos;t be
                attached again.
              </DialogDescription>
            </DialogHeader>
            {detach.error ? (
              <p className="text-xs text-destructive">{detach.error.message}</p>
            ) : null}
            <DialogFooter>
              <Button
                disabled={detach.isPending}
                type="button"
                variant="ghost"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              <Button
                disabled={detach.isPending}
                type="button"
                variant="destructive"
                onClick={() => detach.mutate()}
              >
                {detach.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Unlink />
                )}
                Detach
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
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
      /** What its Brick deploys. Unknown while its repository loads. */
      deploys: AppBrickDeployType | undefined
      /** The Brick it follows, by name, for an App that follows one. */
      follows: string | undefined
      facts: ReadonlyArray<BrickFact>
      state: "ready"
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

// Kiln's own Brick for each thing an App deploys, as its catalog names them
// (`apps/bricks/bricks`). An App is read as the one for what it deploys.
const appBricks: Record<
  AppBrickDeployType,
  { icon: React.ReactNode; name: string }
> = {
  compose: { icon: <Layers />, name: "Docker Compose" },
  dockerfile: { icon: <FileCode2 />, name: "Dockerfile" },
  image: { icon: <Box />, name: "Docker image" },
}

function AppBrickName({
  deploys,
  follows,
}: {
  deploys: AppBrickDeployType | undefined
  follows: string | undefined
}) {
  // An App that follows a Brick is that Brick's, whatever it deploys.
  if (follows !== undefined) {
    return <InstanceProfileBrick icon={<Box />}>{follows}</InstanceProfileBrick>
  }
  if (deploys === undefined) {
    return <p className="mt-1 h-5 text-sm text-muted-foreground">…</p>
  }
  const brick = appBricks[deploys]
  return (
    <InstanceProfileBrick icon={brick.icon}>{brick.name}</InstanceProfileBrick>
  )
}

// Where a Brick that builds a file finds it.
const writtenInHearth: BrickFact = {
  key: "source",
  label: "Source",
  value: "Written in Hearth",
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
  if (!config.data || !saved) return { state: "loading" }
  return {
    deploys:
      saved.sourceType !== "github"
        ? saved.sourceType
        : // With no repository chosen yet, a Dockerfile is what it would build.
          source === null
          ? "dockerfile"
          : source?.build,
    facts:
      saved.sourceType === "github"
        ? githubFacts(app, source)
        : dockerFacts(app, canManage, saved, carriedBy(config.data)),
    follows: config.data.brick?.name,
    state: "ready",
  }
}

function dockerFacts(
  app: App,
  canManage: boolean,
  config: EditableAppConfig,
  // The Brick that carries the file it runs, which is only read then.
  carried: string | null
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
      canManage={canManage && carried === null}
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
  // Its Brick's file wasn't written here, and its Brick is named above.
  const source = carried === null ? [writtenInHearth] : []
  if (kind === "dockerfile") {
    const bases = baseImages(config.dockerfile)
    return [
      ...source,
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
    ...source,
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
      key: "source",
      label: "Source",
      value: (
        <span className="flex min-w-0 items-center gap-1.5">
          <GitHubMark className="size-3.5 shrink-0" />
          GitHub
        </span>
      ),
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
