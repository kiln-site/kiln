import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  appBrickDeploy,
  brickInputs,
  groupBrickInstall,
  type AppBrickDeployType,
  type Brick,
  type BrickVariableValue,
} from "@workspace/contracts"
import { CircleAlert, LoaderCircle, Plus, Rocket } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import {
  AppDatabaseFields,
  appDatabaseInput,
  noAppDatabase,
  type AppDatabaseDraft,
} from "@/components/app/app-database-fields"
import {
  GitHubSourceFields,
  emptyGitHubSourceDraft,
  githubSourceDraftReady,
  type GitHubSourceDraft,
} from "@/components/app/app-github-source-fields"
import type { PickableBrickKind } from "@/components/brick-kinds"
import {
  BrickRelayField,
  useBrickRelayReady,
  type BrickRelayOption,
} from "@/components/brick-relay-field"
import { BrickVariableField } from "@/components/brick-variable-fields"
import { OfferedBrickBrowser } from "@/components/offered-brick-browser"
import { recoverPromise } from "@/effect/promise"
import {
  defaultBrickVariables,
  updateBrickVariable,
} from "@/lib/brick-variables"
import { infraRelayOptionsQueryOptions } from "@/lib/infra-directory"
import { appBricksQueryOptions, queryKeys } from "@/lib/query-options"
import { useIdempotencyKey } from "@/lib/use-idempotency-key"
import { saveAppGitHubSource } from "@/server/app-deployments"
import { createApp } from "@/server/apps"
import { createInstanceGroup } from "@/server/instance-groups"

const NO_RELAYS: ReadonlyArray<BrickRelayOption> = []

/** What a new App is asked to be. */
interface NewAppValues {
  /** The Brick it is installed from, by its source. */
  brick: string
  database: AppDatabaseDraft
  name: string
  relayId: string
  /** Where a Brick that builds a file finds it. Null, it is written later. */
  repository: GitHubSourceDraft | null
  /** Its Brick's answers. */
  variables: Record<string, BrickVariableValue>
}

// The Apps in the Add instance dialog: Kiln's App Bricks, and what a new one
// is asked. Its Brick says what it deploys; a Brick that builds a file is
// also asked where the file is.
export const AddAppPane = React.memo(function AddAppPane({
  kinds,
  onClose,
  onKindChange,
}: {
  kinds: ReadonlyArray<PickableBrickKind>
  onClose: () => void
  onKindChange: (kind: PickableBrickKind) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const bricksQuery = useQuery(appBricksQueryOptions())
  const { data: relays = NO_RELAYS } = useQuery({
    ...infraRelayOptionsQueryOptions("app"),
    select: creatableRelays,
  })
  // Trying the same create again reuses its key, so it reuses its IDs.
  const idempotencyKeyFor = useIdempotencyKey()
  const create = useMutation({
    mutationFn: async ({ database, repository, ...values }: NewAppValues) => {
      const input = {
        ...values,
        database: appDatabaseInput(database, values.name),
      }
      const created = await createApp({
        data: { ...input, idempotencyKey: idempotencyKeyFor(input) },
      })
      if (!repository) return { created, sourceError: null }
      // The App exists by now; a source it can't save is set on its page.
      const sourceError = await recoverPromise(
        () =>
          saveAppGitHubSource({
            data: {
              ...repository,
              appId: created.id,
              deploy: true,
              path: repository.path.trim(),
              relayId: values.relayId,
            },
          }).then(() => null),
        (cause) => (cause instanceof Error ? cause.message : String(cause))
      )
      return { created, sourceError }
    },
    onSuccess: async ({ created, sourceError }) => {
      if (sourceError) {
        showToast({
          message: `App created, but its repository wasn't saved: ${sourceError}`,
          type: "error",
        })
      } else if (created.deployError) {
        showToast({
          message: `App created, but it wasn't deployed: ${created.deployError}`,
          type: "error",
        })
      }
      // The App's page resolves it from the directory, so the directory has
      // it before the page opens.
      await queryClient.invalidateQueries({ queryKey: queryKeys.apps.all })
      onClose()
      await navigate({ params: { appId: created.id }, to: "/app/$appId/info" })
    },
  })

  // A group Brick makes an App with what it needs beside it.
  const install = useMutation({
    mutationFn: (values: NewGroupValues) =>
      createInstanceGroup({
        data: { ...values, idempotencyKey: idempotencyKeyFor(values) },
      }),
    onSuccess: async (created) => {
      if (created.deployError) {
        showToast({
          message: `Installed, but not deployed: ${created.deployError}`,
          type: "error",
        })
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.databases.all }),
      ])
      onClose()
      const [app] = created.apps
      const [database] = created.databases
      if (app) {
        await navigate({ params: { appId: app.id }, to: "/app/$appId/info" })
      } else if (database) {
        await navigate({
          params: { databaseId: database.id },
          to: "/db/$databaseId/info",
        })
      }
    },
  })
  const pending = create.isPending || install.isPending

  return (
    <OfferedBrickBrowser
      bricks={bricksQuery.data}
      disabled={pending}
      emptyMessage="No App Bricks are in your catalogs."
      error={bricksQuery.error?.message}
      kind="app"
      kinds={kinds}
      pending={bricksQuery.isPending}
      onKindChange={onKindChange}
    >
      {(brick) =>
        brick?.kind === "group" ? (
          <NewGroupForm
            key={brick.source}
            brick={brick}
            error={
              install.variables?.brick === brick.source
                ? install.error?.message
                : undefined
            }
            pending={pending}
            relays={relays}
            onClose={onClose}
            onSubmit={install.mutate}
          />
        ) : (
          <NewAppForm
            // Another Brick asks other things, of another source.
            key={brick?.source ?? ""}
            brick={brick}
            // What went wrong creating from another Brick isn't this one's.
            error={
              create.variables?.brick === brick?.source
                ? create.error?.message
                : undefined
            }
            pending={pending}
            relays={relays}
            onClose={onClose}
            onSubmit={create.mutate}
          />
        )
      }
    </OfferedBrickBrowser>
  )
})

/** What installing a group Brick asks. */
interface NewGroupValues {
  brick: string
  name: string
  relayId: string
  variables: Record<string, BrickVariableValue>
}

// A group Brick brings what its App needs, so it asks only what to call it,
// where it goes, and its own questions.
function NewGroupForm({
  brick,
  error,
  onClose,
  onSubmit,
  pending,
  relays,
}: {
  brick: Brick
  error: string | undefined
  onClose: () => void
  onSubmit: (values: NewGroupValues) => void
  pending: boolean
  relays: ReadonlyArray<BrickRelayOption>
}) {
  const [name, setName] = React.useState(brick.metadata.name)
  const [chosenRelayId, setRelayId] = React.useState<string | null>(null)
  const relayId = chosenRelayId ?? relays[0]?.id ?? ""
  const [variables, setVariables] = React.useState(() =>
    defaultBrickVariables(brick)
  )
  const { compatible, connected } = useBrickRelayReady(relays, relayId, brick)
  const refused = React.useMemo(
    () => "problem" in groupBrickInstall(brick, variables),
    [brick, variables]
  )
  const blocked =
    pending || !name.trim() || !relayId || !compatible || !connected || refused

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (blocked) return
        onSubmit({ brick: brick.source, name: name.trim(), relayId, variables })
      }}
    >
      <p className="type-technical-label text-muted-foreground">App details</p>
      <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
        <span>Name</span>
        <Input
          maxLength={120}
          disabled={pending}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      {brickInputs(brick).map((input) => (
        <BrickVariableField
          key={input.key}
          definition={input}
          disabled={pending}
          name={input.key}
          value={variables[input.key]}
          onChange={(value) =>
            setVariables((current) =>
              updateBrickVariable(current, input.key, value)
            )
          }
        />
      ))}
      <BrickRelayField
        brick={brick}
        disabled={pending}
        relays={relays}
        value={relayId}
        onChange={setRelayId}
      />
      <FormError error={error} />
      <div className="grid grid-cols-2 gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={blocked} type="submit">
          {pending ? <LoaderCircle className="animate-spin" /> : <Rocket />}
          Deploy
        </Button>
      </div>
    </form>
  )
}

function FormError({ error }: { error: string | undefined }) {
  return error ? (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive light:bg-destructive/16">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      {error}
    </div>
  ) : null
}

function creatableRelays({
  relays,
}: {
  relays: ReadonlyArray<BrickRelayOption & { canCreate: boolean }>
}): ReadonlyArray<BrickRelayOption> {
  return relays.filter((relay) => relay.canCreate)
}

// Where a Brick that builds a file finds it.
const fileSources = [
  {
    description: "Builds a branch, and redeploys on push",
    id: "repository",
    label: "Repository",
  },
  {
    description: "Written on the App's page, then deployed",
    id: "written",
    label: "Written in Hearth",
  },
] as const
type FileSource = (typeof fileSources)[number]["id"]

const fileNames: Record<Exclude<AppBrickDeployType, "image">, string> = {
  compose: "Compose file",
  dockerfile: "Dockerfile",
}

function NewAppForm({
  brick,
  error,
  onClose,
  onSubmit,
  pending,
  relays,
}: {
  brick: Brick | null
  error: string | undefined
  onClose: () => void
  onSubmit: (values: NewAppValues) => void
  pending: boolean
  relays: ReadonlyArray<BrickRelayOption>
}) {
  const [name, setName] = React.useState("")
  // The Relay chosen, and until one is, the first it can go on.
  const [chosenRelayId, setRelayId] = React.useState<string | null>(null)
  const relayId = chosenRelayId ?? relays[0]?.id ?? ""
  const [variables, setVariables] = React.useState(() =>
    brick ? defaultBrickVariables(brick) : {}
  )
  const [database, setDatabase] =
    React.useState<AppDatabaseDraft>(noAppDatabase)
  // What it deploys with these answers, or why it can't yet.
  const installed = React.useMemo(
    () => (brick ? appBrickDeploy(brick, variables) : null),
    [brick, variables]
  )
  // The file a Brick builds, which an image's doesn't.
  const file =
    brick?.deploy && brick.deploy.type !== "image" ? brick.deploy : null
  const builds = file?.type ?? null
  const [fileSource, setFileSource] = React.useState<FileSource>("repository")
  const [repository, setRepository] = React.useState(() =>
    emptyGitHubSourceDraft(file?.type, file?.path)
  )
  const fromRepository = builds !== null && fileSource === "repository"
  const { compatible, connected } = useBrickRelayReady(relays, relayId, brick)
  const blocked =
    pending ||
    brick === null ||
    !name.trim() ||
    !relayId ||
    !compatible ||
    !connected ||
    installed === null ||
    "problem" in installed ||
    (fromRepository && !githubSourceDraftReady(repository))
  // Something goes out at once when its Brick has all it needs to deploy.
  const deploys = builds === null || fromRepository

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        // A dialog over this form's mustn't submit this one too.
        event.stopPropagation()
        if (blocked || !brick) return
        onSubmit({
          brick: brick.source,
          database,
          name: name.trim(),
          relayId,
          repository: fromRepository ? repository : null,
          variables,
        })
      }}
    >
      <p className="type-technical-label text-muted-foreground">App details</p>
      <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
        <span>Name</span>
        <Input
          maxLength={120}
          placeholder="Website"
          disabled={pending}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      {brick
        ? brickInputs(brick).map((input) => (
            <BrickVariableField
              key={input.key}
              definition={input}
              disabled={pending}
              name={input.key}
              value={variables[input.key]}
              onChange={(value) =>
                setVariables((current) =>
                  updateBrickVariable(current, input.key, value)
                )
              }
            />
          ))
        : null}
      {builds ? (
        <fieldset disabled={pending}>
          <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
            {fileNames[builds]}
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {fileSources.map((option) => (
              <button
                key={option.id}
                aria-pressed={fileSource === option.id}
                className={cn(
                  "flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  fileSource === option.id
                    ? "border-primary/60 bg-primary/10"
                    : "border-border/70 hover:bg-muted/40"
                )}
                type="button"
                onClick={() => setFileSource(option.id)}
              >
                <span className="text-[0.8125rem] font-medium">
                  {option.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {option.description}
                </span>
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
      {fromRepository ? (
        <GitHubSourceFields
          draft={repository}
          fixedBuild
          onChange={setRepository}
        />
      ) : null}
      <BrickRelayField
        brick={brick}
        disabled={pending}
        relays={relays}
        value={relayId}
        onChange={(next) => {
          setRelayId(next)
          // What's on one Relay, or allowed there, isn't on another.
          setDatabase(noAppDatabase)
        }}
      />
      {relayId ? (
        <AppDatabaseFields
          appName={name.trim()}
          draft={database}
          relayId={relayId}
          onChange={setDatabase}
        />
      ) : null}
      <FormError error={error} />
      <div className="grid grid-cols-2 gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={blocked} type="submit">
          {pending ? (
            <LoaderCircle className="animate-spin" />
          ) : deploys ? (
            <Rocket />
          ) : (
            <Plus />
          )}
          {deploys ? "Deploy" : "Create"}
        </Button>
      </div>
    </form>
  )
}
