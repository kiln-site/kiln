import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Effect } from "effect"
import {
  ArrowLeftRight,
  CircleAlert,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
} from "lucide-react"
import {
  brickAnswersProblem,
  brickGame,
  brickMemoryInput,
  type Brick,
  type BrickVariableValue,
} from "@workspace/contracts"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

import {
  BrickSelectDialog,
  type BrickSelection,
} from "@/components/brick-selector"
import { BrickVariableField } from "@/components/brick-variable-fields"
import { MinecraftJavaVersionFields } from "@/components/minecraft-java-version-fields"
import { BrickIcon } from "@/components/brick-icon"
import {
  useInstanceIdentity,
  useInstancePermissions,
  useInstanceRelayConnected,
} from "@/components/instance-workspace-context"
import { WorkspaceSummaryCard } from "@/components/workspace-summary-card"
import {
  brickFields,
  canPairMinecraftJavaVersionFields,
  defaultBrickVariables,
  updateBrickVariable,
  withBrickVariableChanged,
  type BrickFields,
} from "@/lib/brick-variables"
import { managedJavaStartupFlags } from "@/lib/managed-java-flags"
import {
  brickCatalogQueryOptions,
  instanceStartupQueryOptions,
  replaceRelaySnapshotInstance,
} from "@/lib/query-options"
import {
  invalidateRelaySnapshots,
  updateRelaySnapshots,
} from "@/lib/server-workspace"
import { RedeployDialog } from "@/components/redeploy-dialog"
import { redeployInstance, updateInstanceStartup } from "@/server/bricks"

const emptyBricks: Array<Brick> = []

type BrickView = {
  color?: string | undefined
  description: string
  environment: Readonly<Record<string, string>>
  game: string
  id: string
  iconSvg?: string | undefined
  /** The input its memory limit comes from, as one converted from v1 has. */
  memoryInput: string | null
  name: string
  source: string
  variables: BrickFields
}

function brickViewFromBrick(brick: Brick, source = brick.source): BrickView {
  return {
    ...(brick.metadata.color ? { color: brick.metadata.color } : {}),
    description: brick.metadata.summary,
    environment: brick.deploy?.env ?? {},
    game: brickGame(brick),
    id: brick.metadata.id,
    ...(brick.iconSvg ? { iconSvg: brick.iconSvg } : {}),
    memoryInput: brickMemoryInput(brick),
    name: brick.metadata.name,
    source,
    variables: brickFields(brick),
  }
}

interface StartupEditing {
  /** Deploying it again as it is, which takes a permission of its own. */
  canDeploy: boolean
  canEdit: boolean
  canStart: boolean
  canViewConsole: boolean
  canViewLogs: boolean
}

export function StartupWorkspace() {
  const instance = useInstanceIdentity()
  const permissions = useInstancePermissions()
  const relayConnected = useInstanceRelayConnected()
  const startupQuery = useQuery(
    instanceStartupQueryOptions(instance.relayId, instance.id)
  )

  const desiredState = startupQuery.data?.instance.desiredState
  const observedState = startupQuery.data?.instance.observedState
  const editing = React.useMemo<StartupEditing>(
    () => ({
      canDeploy: permissions.deploy && relayConnected,
      canEdit:
        permissions.configurationWrite &&
        relayConnected &&
        (!(
          desiredState === "running" ||
          ["running", "starting", "stopping"].includes(observedState ?? "")
        ) ||
          permissions.powerRestart),
      canStart: permissions.powerStart,
      canViewConsole: permissions.consoleRead,
      canViewLogs: permissions.logsRead,
    }),
    [permissions, relayConnected, desiredState, observedState]
  )

  if (startupQuery.isPending) {
    return (
      <section className="grid min-h-0 flex-1 place-items-center bg-card">
        <LoaderCircle className="size-5 animate-spin text-primary-ink" />
      </section>
    )
  }

  if (startupQuery.error || !startupQuery.data) {
    return (
      <section className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
        <div className="max-w-sm">
          <CircleAlert className="mx-auto size-5 text-amber-300 light:text-amber-700" />
          <p className="mt-3 text-sm font-semibold">Startup unavailable</p>
          <p className="type-support mt-1 text-muted-foreground">
            {startupQuery.error?.message ??
              "This server does not expose Brick startup variables yet."}
          </p>
        </div>
      </section>
    )
  }

  return (
    <StartupForm
      key={`${instance.relayId}:${instance.id}:${startupQuery.dataUpdatedAt}`}
      brick={startupQuery.data.brick}
      brickSource={startupQuery.data.brickSource}
      editing={editing}
      memoryBytes={
        (
          startupQuery.data.instance.pendingLimits ??
          startupQuery.data.instance.limits
        ).memoryBytes
      }
      initialVariables={startupQuery.data.variables}
      instanceId={instance.id}
      observedState={startupQuery.data.instance.observedState}
      relayId={instance.relayId}
    />
  )
}

const StartupForm = React.memo(function StartupForm({
  brick: initialBrick,
  brickSource: initialBrickSource,
  editing,
  memoryBytes,
  initialVariables,
  instanceId,
  observedState,
  relayId,
}: {
  brick: Brick
  brickSource: string
  editing: StartupEditing
  memoryBytes: number | null
  initialVariables: Record<string, BrickVariableValue>
  instanceId: string
  observedState: string
  relayId: string
}) {
  const { canDeploy, canEdit, canStart } = editing
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [view, setView] = React.useState(() =>
    brickViewFromBrick(initialBrick, initialBrickSource)
  )
  const [variables, setVariables] =
    React.useState<Record<string, BrickVariableValue>>(initialVariables)
  const [swapOpen, setSwapOpen] = React.useState(false)
  const [redeployOpen, setRedeployOpen] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  const catalogQuery = useQuery({
    ...brickCatalogQueryOptions(),
    enabled: swapOpen && canEdit,
  })

  const saveMutation = useMutation({
    mutationFn: updateInstanceStartup,
    onSuccess: async (updated) => {
      updateRelaySnapshots(queryClient, (current) => {
        const previous = current?.instances.find(
          (item) => item.id === updated.id && item.relayId === relayId
        )
        return replaceRelaySnapshotInstance(current, {
          ...updated,
          name: previous?.name ?? updated.name,
          relayId,
        })
      })
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["relay", relayId, "instances", instanceId, "startup"],
        }),
        invalidateRelaySnapshots(queryClient),
      ])
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2_000)
    },
  })
  const redeployMutation = useMutation({
    mutationFn: redeployInstance,
    onSuccess: async (updated) => {
      updateRelaySnapshots(queryClient, (current) => {
        const previous = current?.instances.find(
          (item) => item.id === updated.id && item.relayId === relayId
        )
        return replaceRelaySnapshotInstance(current, {
          ...updated,
          name: previous?.name ?? updated.name,
          relayId,
        })
      })
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["relay", relayId, "instances", instanceId, "startup"],
        }),
        invalidateRelaySnapshots(queryClient),
      ])
      showToast({
        type: "success",
        message: "Game server redeployed",
        description: "Its container was replaced from the Brick's image.",
      })
    },
  })
  const pending = saveMutation.isPending || redeployMutation.isPending
  const submittingRef = React.useRef(false)
  const isRunning = observedState === "running"

  function applyBrickSelection(selection: BrickSelection) {
    if (selection.kind === "catalog") {
      setView(brickViewFromBrick(selection.brick))
      setVariables(defaultBrickVariables(selection.brick))
      setError(null)
      return
    }
    const source = selection.source.trim()
    setView({
      description: "Custom HTTPS recipe",
      environment: {},
      game: "Custom",
      id: "custom",
      memoryInput: null,
      name: "Custom Brick",
      source,
      variables: {},
    })
    setVariables({})
    setError(null)
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit || pending || submittingRef.current) return
    setError(null)
    // Said here as the Relay would say it, before anything is stopped.
    const problem = brickAnswersProblem(Object.values(view.variables), variables)
    if (problem) {
      setError(`${problem.message}.`)
      return
    }
    submittingRef.current = true
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          saveMutation
            .mutateAsync({
              data: {
                instanceId,
                recipe: view.source,
                relayId,
                start: canStart,
                variables,
              },
            })
            .then(async () => {
              if (isRunning || !canStart || !editing.canViewConsole) return
              await navigate({
                to: "/server/$serverId/console",
                params: { serverId: instanceId },
              })
            }),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            setError(
              cause instanceof Error ? cause.message : "Could not apply Startup"
            )
          )
        ),
        Effect.ensuring(
          Effect.sync(() => {
            submittingRef.current = false
          })
        )
      )
    )
  }

  async function onRedeploy() {
    if (!canDeploy || pending || submittingRef.current) return
    setError(null)
    setRedeployOpen(false)
    // Follow the deployment as it happens, as an App's is.
    if (editing.canViewLogs) {
      void navigate({
        params: { serverId: instanceId },
        to: "/server/$serverId/logs",
      })
    }
    submittingRef.current = true
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          redeployMutation.mutateAsync({
            data: { instanceId, relayId },
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            const message =
              cause instanceof Error
                ? cause.message
                : "Could not redeploy the game server"
            // Said here for whoever stayed, and wherever they went.
            setError(message)
            showToast({ type: "error", message: `Redeploy failed: ${message}` })
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            submittingRef.current = false
          })
        )
      )
    )
  }

  // The container's memory limit replaces the Brick's memory variable,
  // which stays out of the form.
  const memoryVariable = view.memoryInput
  const catalogBrick =
    [
      ...(catalogQuery.data?.bricks ?? emptyBricks),
      ...(catalogQuery.data?.customBricks ?? emptyBricks),
    ].find((item) => item.source === view.source) ??
    (initialBrick.source === view.source ? initialBrick : null)
  const swapInitial: BrickSelection | null = catalogBrick
    ? { kind: "catalog", brick: catalogBrick }
    : view.id === "custom"
      ? { kind: "custom", source: view.source }
      : initialBrick
        ? { kind: "catalog", brick: initialBrick }
        : null

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto max-w-3xl space-y-6 px-5 py-6 sm:px-8 sm:py-8">
        <StartupSettingsForm
          editing={editing}
          error={error}
          isRunning={isRunning}
          memoryBytes={memoryBytes}
          pending={pending}
          saved={saved}
          memoryVariable={memoryVariable}
          variables={variables}
          view={view}
          onRedeploy={() => setRedeployOpen(true)}
          onSubmit={onSubmit}
          onSwap={() => setSwapOpen(true)}
          onVariableChange={(name, value) => {
            if (!canEdit) return
            setVariables((current) => {
              // What follows this answer follows it now.
              return withBrickVariableChanged(
                view.variables,
                updateBrickVariable(current, name, value),
                name
              )
            })
          }}
        />
      </div>

      {canEdit ? (
        <>
          <StartupBrickSwapDialog
            open={swapOpen}
            onOpenChange={setSwapOpen}
            relayId={relayId}
            bricks={catalogQuery.data?.bricks ?? emptyBricks}
            canAddCustomBrick={catalogQuery.data?.canAddCustomBrick ?? false}
            customBricks={catalogQuery.data?.customBricks ?? emptyBricks}
            loading={catalogQuery.isPending}
            error={catalogQuery.error?.message ?? null}
            initial={swapInitial}
            onConfirm={applyBrickSelection}
          />
        </>
      ) : null}
      {canDeploy ? (
        <>
          <RedeployDialog
            name={initialBrick.metadata.name}
            error={null}
            open={redeployOpen}
            pending={false}
            onOpenChange={(open) => {
              setRedeployOpen(open)
              if (open) setError(null)
            }}
            onConfirm={() => {
              void onRedeploy()
            }}
          >
            Pulls the Brick's image again and replaces the container. The
            server restarts if it is running. Its files stay on the volume,
            and unsaved Startup changes are not applied.
          </RedeployDialog>
        </>
      ) : null}
    </section>
  )
})

function StartupSettingsForm({
  editing,
  error,
  isRunning,
  memoryBytes,
  pending,
  saved,
  memoryVariable,
  variables,
  view,
  onRedeploy,
  onSubmit,
  onSwap,
  onVariableChange,
}: {
  editing: StartupEditing
  error: string | null
  isRunning: boolean
  memoryBytes: number | null
  pending: boolean
  saved: boolean
  memoryVariable: string | null
  variables: Record<string, BrickVariableValue>
  view: BrickView
  onRedeploy: () => void
  onSubmit: React.FormEventHandler<HTMLFormElement>
  onSwap: () => void
  onVariableChange: (
    name: string,
    value: BrickVariableValue | undefined
  ) => void
}) {
  const { canDeploy, canEdit, canStart } = editing
  const variableDefinitions = view.variables
  const javaArgsDefinition = variableDefinitions.java_args
  const pairVersionAndJava =
    canPairMinecraftJavaVersionFields(variableDefinitions)
  const groupedNames = new Set(
    [
      memoryVariable,
      pairVersionAndJava ? "version" : null,
      pairVersionAndJava ? "java_version" : null,
      javaArgsDefinition ? "java_args" : null,
    ].filter((name): name is string => name !== null)
  )
  const entries = Object.entries(variableDefinitions).filter(
    ([name]) => !groupedNames.has(name)
  )
  const managedFlags = javaArgsDefinition
    ? managedJavaStartupFlags(
        view.environment,
        javaContainerMemory(memoryBytes),
        variables,
        {
          id: view.id,
          name: view.name,
        }
      )
    : null
  const hasFields =
    entries.length > 0 || pairVersionAndJava || Boolean(javaArgsDefinition)

  return (
    <form className="space-y-6" onSubmit={onSubmit}>
      <StartupSection title="Brick Configuration">
        <div className="overflow-hidden rounded-xl border border-border/75 bg-background/45">
          <BrickSummary
            view={view}
            canDeploy={canDeploy}
            canEdit={canEdit}
            pending={pending}
            onRedeploy={onRedeploy}
            onSwap={onSwap}
          />
          {hasFields ? (
            <div className="space-y-3 border-t border-border/65 p-4">
              {pairVersionAndJava ? (
                <MinecraftJavaVersionFields
                  disabled={!canEdit || pending}
                  environment={view.environment}
                  javaVersion={
                    typeof variables.java_version === "string"
                      ? variables.java_version
                      : ""
                  }
                  onJavaVersionChange={(value) =>
                    onVariableChange("java_version", value)
                  }
                  onVersionChange={(value) =>
                    onVariableChange("version", value)
                  }
                  showDescriptions={false}
                  variableDefinitions={variableDefinitions}
                  version={
                    typeof variables.version === "string"
                      ? variables.version
                      : ""
                  }
                />
              ) : null}
              {entries.map(([name, definition]) => (
                <BrickVariableField
                  key={name}
                  disabled={!canEdit || pending}
                  name={name}
                  definition={definition}
                  value={variables[name]}
                  onChange={(value) => onVariableChange(name, value)}
                />
              ))}
              {javaArgsDefinition ? (
                <>
                  <ManagedJavaFlagsField value={managedFlags ?? ""} />
                  <BrickVariableField
                    description={javaArgsDefinition.help?.replace(
                      /^Extra JVM flags\.\s*/u,
                      ""
                    )}
                    disabled={!canEdit || pending}
                    name="java_args"
                    definition={javaArgsDefinition}
                    value={variables.java_args}
                    onChange={(value) => onVariableChange("java_args", value)}
                  />
                </>
              ) : null}
            </div>
          ) : (
            <div className="border-t border-border/65 px-4 py-8 text-center text-xs text-muted-foreground">
              This Brick has no configurable Startup variables.
            </div>
          )}
        </div>
      </StartupSection>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive light:bg-destructive/16">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {!canEdit ? (
          <p className="type-support mr-auto text-muted-foreground">
            Changing Startup requires configuration access and a connected
            Relay. A running server also requires restart permission.
          </p>
        ) : null}
        <Button type="submit" disabled={!canEdit || pending}>
          {pending ? (
            <LoaderCircle className="animate-spin" />
          ) : saved ? (
            <Save />
          ) : isRunning ? (
            <RotateCcw />
          ) : (
            <Play />
          )}
          {pending
            ? "Applying…"
            : saved
              ? "Applied"
              : isRunning
                ? "Apply & Restart"
                : canStart
                  ? "Apply & Start"
                  : "Apply"}
        </Button>
      </div>
    </form>
  )
}

const ManagedJavaFlagsField = React.memo(function ManagedJavaFlagsField({
  value,
}: {
  value: string
}) {
  const labelId = React.useId()
  return (
    <div className="type-label block space-y-1.5 text-muted-foreground">
      <span className="flex items-center justify-between gap-2">
        <span id={labelId}>Managed flags</span>
        <span className="type-meta font-mono text-muted-foreground">ember</span>
      </span>
      <Input
        aria-labelledby={labelId}
        value={value}
        readOnly
        disabled
        className="font-mono text-xs md:text-xs"
      />
    </div>
  )
})

function StartupSection({
  accessory,
  children,
  description,
  title,
}: {
  accessory?: React.ReactNode
  children: React.ReactNode
  description?: string
  title: string
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="type-technical-label text-primary-ink">{title}</p>
          {description ? (
            <p className="type-meta mt-0.5 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {accessory}
      </div>
      {children}
    </section>
  )
}

function BrickSummary({
  view,
  canDeploy,
  canEdit,
  pending,
  onRedeploy,
  onSwap,
}: {
  view: BrickView
  canDeploy: boolean
  canEdit: boolean
  pending: boolean
  onRedeploy: () => void
  onSwap: () => void
}) {
  return (
    <WorkspaceSummaryCard
      action={
        canDeploy || canEdit ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {canDeploy ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={onRedeploy}
              >
                <RefreshCw />
                Redeploy
              </Button>
            ) : null}
            {canEdit ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={onSwap}
              >
                <ArrowLeftRight />
                Swap Brick
              </Button>
            ) : null}
          </div>
        ) : null
      }
      className="rounded-none border-0 bg-transparent"
      iconClassName="size-[56px]!"
      icon={
        <BrickIcon
          id={view.id}
          color={view.color}
          iconSvg={view.iconSvg}
          className="size-[42px]"
        />
      }
      title={view.name}
      titleAccessory={
        <Badge variant="outline" className="type-meta font-mono">
          {view.game}
        </Badge>
      }
    >
      <p className="type-meta mt-0.5 truncate text-muted-foreground">
        {view.description}
      </p>
    </WorkspaceSummaryCard>
  )
}

/** The memory limit as Java sizes its heap from it, like `2048m`. */
function javaContainerMemory(bytes: number | null): string | undefined {
  return bytes === null ? undefined : `${Math.round(bytes / 1024 ** 2)}m`
}

const StartupBrickSwapDialog = React.memo(function StartupBrickSwapDialog({
  open,
  onOpenChange,
  relayId,
  bricks,
  canAddCustomBrick,
  customBricks,
  loading,
  error,
  initial,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  relayId: string
  bricks: Array<Brick>
  canAddCustomBrick: boolean
  customBricks: Array<Brick>
  loading: boolean
  error: string | null
  initial: BrickSelection | null
  onConfirm: (selection: BrickSelection) => void
}) {
  if (loading) {
    return (
      <BrickSelectDialog
        open={open}
        onOpenChange={onOpenChange}
        relayId={relayId}
        bricks={[]}
        canAddCustomBrick={canAddCustomBrick}
        customBricks={customBricks}
        initial={null}
        title="Swap Brick"
        description="Loading Brick catalog…"
        confirmLabel="Use Brick"
        onConfirm={() => undefined}
      />
    )
  }

  if (error || (bricks.length === 0 && customBricks.length === 0)) {
    return (
      <BrickSelectDialog
        open={open}
        onOpenChange={onOpenChange}
        relayId={relayId}
        bricks={[]}
        canAddCustomBrick={canAddCustomBrick}
        customBricks={customBricks}
        initial={null}
        title="Swap Brick"
        description={
          error ?? "Brick catalog unavailable. Connect a Relay and try again."
        }
        confirmLabel="Use Brick"
        onConfirm={() => undefined}
      />
    )
  }

  return (
    <BrickSelectDialog
      open={open}
      onOpenChange={onOpenChange}
      relayId={relayId}
      bricks={bricks}
      canAddCustomBrick={canAddCustomBrick}
      customBricks={customBricks}
      initial={initial}
      title="Swap Brick"
      description="Pick another catalog Brick or a custom recipe. Startup options save as you edit; apply to rebuild the container and start it."
      confirmLabel="Use Brick"
      onConfirm={onConfirm}
    />
  )
})
