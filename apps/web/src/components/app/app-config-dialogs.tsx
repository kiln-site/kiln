import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import type { AppConfig, AppSourceType } from "@workspace/contracts"
import { LoaderCircle, Rocket } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import {
  showAppOperationError,
  sourceTypeLabels,
  type App,
} from "@/components/app/app-presentation"
import { CodeDocumentPanel } from "@/components/code-document-panel"
import { recoverPromise } from "@/effect/promise"
import { instanceInventoryScope } from "@/lib/instance-inventory"
import {
  GitHubSourceFields,
  githubSourceDraftReady,
  emptyGitHubSourceDraft,
  type GitHubSourceDraft,
} from "@/components/app/app-github-source-fields"
import { appDeploymentSummaryQueryOptions, queryKeys } from "@/lib/query-options"
import { saveAppGitHubSource } from "@/server/app-deployments"
import { deployApp, updateAppConfig } from "@/server/apps"

// Dialogs that change what an app runs. Each saves only its own fields, then
// deploys when asked; changes otherwise apply on the next deploy.

export type EditableAppConfig = Omit<AppConfig, "databaseIds">
type SaveNext = "deploy" | "stay"

export function useAppConfigSave(
  app: Pick<App, "id" | "permissions" | "relayId">,
  routeId: string
) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: async ({
      config,
      github,
      next,
    }: {
      config: Partial<EditableAppConfig>
      /** Makes this repository the app's source, deploying it if asked. */
      github?: GitHubSourceDraft
      next: SaveNext
    }) => {
      const result = await updateAppConfig({
        data: { appId: app.id, config, relayId: app.relayId },
      })
      if (github) {
        const saved = await saveAppGitHubSource({
          data: {
            ...github,
            appId: app.id,
            deploy: next === "deploy",
            path: github.path.trim(),
            relayId: app.relayId,
          },
        })
        return { config: saved.config, next }
      }
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
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: instanceInventoryScope({
            kind: "app",
            relayId: app.relayId,
            id: app.id,
          }),
        }),
        // Its rail shows the repository only while GitHub is its source.
        queryClient.invalidateQueries({
          queryKey: queryKeys.appDeployments.summary(app.relayId, app.id),
        }),
      ])
      // Follow the deployment as it happens.
      if (next === "deploy" && app.permissions.includes("app.logs.read")) {
        await navigate({
          params: { appId: routeId },
          search: { stream: "deployment" },
          to: "/app/$appId/logs",
        })
        return
      }
      showToast({
        message: next === "deploy" ? "Saved and deploying" : "Saved",
        type: "success",
      })
    },
    onError: (error) => showAppOperationError("Could not save", error),
  })
}

export const appDocuments = {
  compose: {
    hint: "Services reach each other by name. Containers keep nothing across deploys; mount a volume from the Volumes section to keep data.",
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
  environment: {
    hint: "KEY=VALUE lines, passed to the containers, and to a Compose file as ${KEY}.",
    noun: "environment",
    path: ".env",
    placeholder: "DATABASE_URL=postgres://…\nNODE_ENV=production",
  },
} as const

export type AppDocumentKind = keyof typeof appDocuments

// A Dockerfile, Compose file, or the environment, read or edited in the
// code dialog a Brick recipe opens in.
export function AppDocumentDialog({
  kind,
  ...props
}: {
  app: Pick<App, "id" | "permissions" | "relayId">
  canManage: boolean
  deploying: boolean
  kind: AppDocumentKind
  onOpenChange: (open: boolean) => void
  routeId: string
  saved: string
}) {
  return (
    <AppCodeDialog
      {...props}
      configFor={(draft) => ({ [kind]: draft })}
      document={appDocuments[kind]}
    />
  )
}

// Any text the app's config keeps, read or edited in the code dialog, and
// saved into the config as `configFor` places it.
export function AppCodeDialog({
  app,
  canManage,
  configFor,
  deploying,
  document,
  onOpenChange,
  routeId,
  saved,
}: {
  app: Pick<App, "id" | "permissions" | "relayId">
  canManage: boolean
  configFor: (draft: string) => Partial<EditableAppConfig>
  deploying: boolean
  document: { hint: string; noun: string; path: string; placeholder: string }
  onOpenChange: (open: boolean) => void
  routeId: string
  saved: string
}) {
  const [draft, setDraft] = React.useState(saved)
  const save = useAppConfigSave(app, routeId)
  const submit = async (next: SaveNext) => {
    // The mutation reports failures; the dialog stays open for them.
    const done = await recoverPromise(
      () =>
        save.mutateAsync({ config: configFor(draft), next }).then(() => true),
      () => false
    )
    if (done) onOpenChange(false)
  }
  const pending = save.isPending ? save.variables.next : null

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="sr-only">
          <DialogTitle>{document.path}</DialogTitle>
          <DialogDescription>{document.hint}</DialogDescription>
        </DialogHeader>
        <CodeDocumentPanel
          actions={
            canManage ? (
              <>
                <Button
                  disabled={pending !== null || draft === saved}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => void submit("stay")}
                >
                  {pending === "stay" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : null}
                  Save
                </Button>
                <Button
                  disabled={pending !== null || deploying}
                  size="sm"
                  type="button"
                  onClick={() => void submit("deploy")}
                >
                  {pending === "deploy" ? (
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

const sourceTypes: ReadonlyArray<AppSourceType> = [
  "github",
  "image",
  "dockerfile",
  "compose",
]

const sourceTypeDetails: Record<AppSourceType, string> = {
  compose: "Services from a Compose file",
  dockerfile: "Built on the Relay",
  github: "Built from a repository",
  image: "Pulled from a registry",
}

type SourceDraft = Pick<
  EditableAppConfig,
  "command" | "image" | "sourceType"
>

// What the app deploys from, and how a single container starts. Every
// source is kept, so switching between them loses nothing.
export function AppSourceDialog({
  app,
  deploying,
  onOpenChange,
  routeId,
  saved,
}: {
  app: Pick<App, "id" | "permissions" | "relayId">
  deploying: boolean
  onOpenChange: (open: boolean) => void
  routeId: string
  saved: EditableAppConfig
}) {
  const initial = React.useMemo<SourceDraft>(
    () => ({
      command: saved.command,
      image: saved.image,
      sourceType: saved.sourceType,
    }),
    [saved]
  )
  const [draft, setDraft] = React.useState(initial)
  const summary = useQuery(
    appDeploymentSummaryQueryOptions(app.relayId, app.id)
  )
  const savedGitHub = React.useMemo<GitHubSourceDraft | null>(() => {
    const source = summary.data?.savedSource
    return source
      ? {
          autoDeploy: source.autoDeploy,
          branch: source.branch,
          build: source.build,
          connectionId: source.connectionId ?? "",
          path: source.path,
          repository: source.repository,
        }
      : null
  }, [summary.data?.savedSource])
  const [github, setGitHub] = React.useState<GitHubSourceDraft | null>(null)
  const githubDraft = github ?? savedGitHub ?? emptyGitHubSourceDraft()
  const save = useAppConfigSave(app, routeId)
  const dirty =
    draft.command !== initial.command ||
    draft.image !== initial.image ||
    draft.sourceType !== initial.sourceType ||
    (draft.sourceType === "github" && github !== null)
  const update = <K extends keyof SourceDraft>(key: K, value: SourceDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))
  const submit = async (next: SaveNext) => {
    const { sourceType, ...rest } = draft
    // Saving the repository makes GitHub the source. It's saved only when
    // it changes, since that needs its source's owner.
    const saveRepository =
      sourceType === "github" &&
      (github !== null || initial.sourceType !== "github")
    const done = await recoverPromise(
      () =>
        save
          .mutateAsync(
            saveRepository
              ? { config: rest, github: githubDraft, next }
              : { config: draft, next }
          )
          .then(() => true),
      () => false
    )
    if (done) onOpenChange(false)
  }
  const pending = save.isPending ? save.variables.next : null
  const singleContainer =
    draft.sourceType === "github"
      ? githubDraft.build === "dockerfile"
      : draft.sourceType !== "compose"
  const document =
    draft.sourceType === "image" || draft.sourceType === "github"
      ? null
      : appDocuments[draft.sourceType]
  const ready =
    draft.sourceType !== "github" || githubSourceDraftReady(githubDraft)

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(92dvh,52rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Source</DialogTitle>
          <DialogDescription>
            What the app deploys from. Changes apply on the next deploy.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit("stay")
          }}
        >
          <div
            role="radiogroup"
            aria-label="Source"
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {sourceTypes.map((type) => (
              <button
                key={type}
                role="radio"
                aria-checked={draft.sourceType === type}
                type="button"
                className={cn(
                  "flex flex-col gap-0.5 border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  draft.sourceType === type
                    ? "border-primary/60 bg-primary/10"
                    : "hover:bg-muted/40"
                )}
                onClick={() => update("sourceType", type)}
              >
                <span className="text-[0.8125rem] font-medium">
                  {sourceTypeLabels[type]}
                </span>
                <span className="text-xs text-muted-foreground">
                  {sourceTypeDetails[type]}
                </span>
              </button>
            ))}
          </div>
          {draft.sourceType === "image" ? (
            <SourceField
              hint="Pulled on every deploy from Docker Hub or any registry the Relay can reach."
              label="Image and tag"
            >
              <Input
                autoFocus
                className="font-mono"
                placeholder="nginx:latest"
                spellCheck={false}
                value={draft.image}
                onChange={(event) => update("image", event.currentTarget.value)}
              />
            </SourceField>
          ) : draft.sourceType === "github" ? (
            // Opens on the saved repository, once it's known.
            summary.isPending ? (
              <div className="grid h-24 place-items-center">
                <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <GitHubSourceFields draft={githubDraft} onChange={setGitHub} />
            )
          ) : document ? (
            <p className="border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
              {document.hint} Edit the {document.noun} from the Source section.
            </p>
          ) : null}
          {singleContainer ? (
            <SourceField label="Start command">
              <Input
                className="font-mono"
                placeholder="Image default"
                spellCheck={false}
                value={draft.command}
                onChange={(event) =>
                  update("command", event.currentTarget.value)
                }
              />
            </SourceField>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={pending !== null || !dirty || !ready}
              type="submit"
              variant="outline"
            >
              {pending === "stay" ? (
                <LoaderCircle className="animate-spin" />
              ) : null}
              Save
            </Button>
            <Button
              disabled={pending !== null || deploying || !ready}
              type="button"
              onClick={() => void submit("deploy")}
            >
              {pending === "deploy" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Rocket />
              )}
              Save and deploy
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SourceField({
  children,
  hint,
  label,
}: {
  children: React.ReactNode
  hint?: string
  label: string
}) {
  return (
    <label className="block">
      <span className="type-technical-label mb-2 block text-muted-foreground">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="type-meta mt-2 block text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </label>
  )
}
