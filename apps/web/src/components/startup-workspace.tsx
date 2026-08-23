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
import type {
  Brick,
  BrickVariableValue,
  RelayInstanceLimits,
} from "@workspace/contracts"

import { Badge } from "@workspace/ui/components/badge"
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

import {
  BrickSelectDialog,
  type BrickSelection,
} from "@/components/brick-selector"
import { BrickVariableField } from "@/components/brick-variable-fields"
import { MinecraftJavaVersionFields } from "@/components/minecraft-java-version-fields"
import { ServerTypeIcon } from "@/components/server-type-icon"
import {
  formatResourceBytes,
  ResourceAllocationCard,
  type StartupResourceAllocation,
} from "@/components/startup-resource-allocation"
import {
  useInstanceIdentity,
  useInstancePermissions,
  useInstanceRelayConnected,
} from "@/components/instance-workspace-context"
import { WorkspaceSummaryCard } from "@/components/workspace-summary-card"
import {
  canPairMinecraftJavaVersionFields,
  defaultBrickVariables,
  unavailableMinecraftJavaVersion,
  updateBrickVariable,
  withRecommendedMinecraftJava,
} from "@/lib/brick-variables"
import {
  dockerMemoryBytes,
  managedJavaStartupFlags,
} from "@/lib/managed-java-flags"
import {
  brickCatalogQueryOptions,
  instanceStartupQueryOptions,
  queryKeys,
  replaceRelaySnapshotInstance,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { updateInstanceStartup } from "@/server/bricks"

const emptyBricks: Array<Brick> = []

type BrickView = {
  description: string
  environment: Brick["runtime"]["environment"]
  game: string
  id: string
  memoryTemplate: string
  name: string
  source: string
  variables: Brick["variables"]
}

function brickViewFromBrick(brick: Brick, source = brick.source): BrickView {
  return {
    description: brick.metadata.description,
    environment: brick.runtime.environment,
    game: brick.metadata.game,
    id: brick.metadata.id,
    memoryTemplate: brick.runtime.resources.memory,
    name: brick.metadata.name,
    source,
    variables: brick.variables,
  }
}

export function StartupWorkspace() {
  const instance = useInstanceIdentity()
  const permissions = useInstancePermissions()
  const relayConnected = useInstanceRelayConnected()
  const startupQuery = useQuery(
    instanceStartupQueryOptions(instance.relayId, instance.id)
  )

  if (startupQuery.isPending) {
    return (
      <section className="grid min-h-0 flex-1 place-items-center bg-card">
        <LoaderCircle className="size-5 animate-spin text-primary" />
      </section>
    )
  }

  if (startupQuery.error || !startupQuery.data) {
    return (
      <section className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
        <div className="max-w-sm">
          <CircleAlert className="mx-auto size-5 text-amber-300" />
          <p className="mt-3 text-sm font-semibold">Startup unavailable</p>
          <p className="mt-1 text-[0.6875rem] leading-5 text-muted-foreground">
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
      canEdit={permissions.settings && relayConnected}
      allocation={startupQuery.data.allocation}
      initialLimits={startupQuery.data.instance.limits}
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
  canEdit,
  allocation,
  initialLimits,
  initialVariables,
  instanceId,
  observedState,
  relayId,
}: {
  brick: Brick
  brickSource: string
  canEdit: boolean
  allocation: StartupResourceAllocation
  initialLimits: RelayInstanceLimits
  initialVariables: Record<string, BrickVariableValue>
  instanceId: string
  observedState: string
  relayId: string
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [view, setView] = React.useState(() =>
    brickViewFromBrick(initialBrick, initialBrickSource)
  )
  const [variables, setVariables] =
    React.useState<Record<string, BrickVariableValue>>(initialVariables)
  const [diskLimitGiB, setDiskLimitGiB] = React.useState(() =>
    bytesToGiBInput(initialLimits.diskBytes)
  )
  const [swapOpen, setSwapOpen] = React.useState(false)
  const [reinstallOpen, setReinstallOpen] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  const catalogQuery = useQuery({
    ...brickCatalogQueryOptions(),
    enabled: swapOpen && canEdit,
  })

  const saveMutation = useMutation({
    mutationFn: updateInstanceStartup,
    onSuccess: async (updated) => {
      queryClient.setQueryData<RelayFleetSnapshot>(
        queryKeys.relay.snapshot,
        (current) => {
          const previous = current?.instances.find(
            (item) => item.id === updated.id && item.relayId === relayId
          )
          return replaceRelaySnapshotInstance(current, {
            ...updated,
            name: previous?.name ?? updated.name,
            relayId,
          })
        }
      )
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["relay", relayId, "instances", instanceId, "startup"],
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.relay.snapshot }),
      ])
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2_000)
    },
  })
  const reinstallMutation = useMutation({
    mutationFn: updateInstanceStartup,
    onSuccess: async (updated) => {
      queryClient.setQueryData<RelayFleetSnapshot>(
        queryKeys.relay.snapshot,
        (current) => {
          const previous = current?.instances.find(
            (item) => item.id === updated.id && item.relayId === relayId
          )
          return replaceRelaySnapshotInstance(current, {
            ...updated,
            name: previous?.name ?? updated.name,
            relayId,
          })
        }
      )
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["relay", relayId, "instances", instanceId, "startup"],
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.relay.snapshot }),
      ])
      setReinstallOpen(false)
      showToast({
        type: "success",
        message: "Brick reinstalled",
        description: "The container was rebuilt from the current Ember image.",
      })
    },
  })
  const pending = saveMutation.isPending || reinstallMutation.isPending
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
      memoryTemplate: "",
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
    const minecraftVersion = variables.version
    const unavailableJavaVersion =
      typeof minecraftVersion === "string"
        ? unavailableMinecraftJavaVersion(
            view.id,
            view.variables,
            minecraftVersion,
            variables.java_version
          )
        : null
    if (unavailableJavaVersion) {
      setError(
        `Minecraft ${minecraftVersion} requires Java ${unavailableJavaVersion}, but that Ember is not published yet.`
      )
      return
    }
    const diskLimitBytes = gibibytesToBytes(diskLimitGiB)
    if (diskLimitBytes === null) {
      setError("Enter a valid disk quota in GiB.")
      return
    }
    if (
      diskLimitBytes > 0 &&
      diskLimitBytes > allocation.storage.availableBytes
    ) {
      setError(
        `Disk quota exceeds the ${formatResourceBytes(allocation.storage.availableBytes)} available to this server.`
      )
      return
    }
    const memoryLimitBytes = resolvedMemoryBytes(view.memoryTemplate, variables)
    if (
      memoryLimitBytes !== null &&
      memoryLimitBytes > allocation.memory.availableBytes
    ) {
      setError(
        `Container memory exceeds the ${formatResourceBytes(allocation.memory.availableBytes)} available to this server.`
      )
      return
    }
    submittingRef.current = true
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          saveMutation
            .mutateAsync({
              data: {
                diskLimitBytes,
                instanceId,
                recipe: view.source,
                relayId,
                start: true,
                variables,
              },
            })
            .then(async () => {
              if (isRunning) return
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

  async function onReinstall() {
    if (!canEdit || pending || submittingRef.current) return
    setError(null)
    submittingRef.current = true
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          reinstallMutation.mutateAsync({
            data: {
              instanceId,
              reinstall: true,
              relayId,
            },
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not reinstall Brick"
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

  const memoryValue = resolvedMemoryValue(view.memoryTemplate, variables)
  const configuredMemoryBytes =
    (memoryValue ? dockerMemoryBytes(memoryValue) : null) ??
    initialLimits.memoryBytes
  const memoryVariable = brickMemoryVariable(view.memoryTemplate)
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
          allocation={allocation}
          canEdit={canEdit}
          configuredMemoryBytes={configuredMemoryBytes}
          diskLimitGiB={diskLimitGiB}
          error={reinstallOpen ? null : error}
          isRunning={isRunning}
          pending={pending}
          saved={saved}
          memoryVariable={memoryVariable}
          memoryValue={memoryValue}
          variables={variables}
          view={view}
          onDiskLimitChange={setDiskLimitGiB}
          onReinstall={() => setReinstallOpen(true)}
          onSubmit={onSubmit}
          onSwap={() => setSwapOpen(true)}
          onVariableChange={(name, value) => {
            if (!canEdit) return
            setVariables((current) => {
              const updated = updateBrickVariable(current, name, value)
              return name === "version"
                ? withRecommendedMinecraftJava(view.id, view.variables, updated)
                : updated
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
          <StartupBrickReinstallDialog
            brickName={initialBrick.metadata.name}
            error={reinstallOpen ? error : null}
            open={reinstallOpen}
            pending={reinstallMutation.isPending}
            onOpenChange={(open) => {
              if (reinstallMutation.isPending) return
              setReinstallOpen(open)
              if (open) setError(null)
            }}
            onConfirm={() => {
              void onReinstall()
            }}
          />
        </>
      ) : null}
    </section>
  )
})

function StartupSettingsForm({
  allocation,
  canEdit,
  configuredMemoryBytes,
  diskLimitGiB,
  error,
  isRunning,
  pending,
  saved,
  memoryVariable,
  memoryValue,
  variables,
  view,
  onDiskLimitChange,
  onReinstall,
  onSubmit,
  onSwap,
  onVariableChange,
}: {
  allocation: StartupResourceAllocation
  canEdit: boolean
  configuredMemoryBytes: number
  diskLimitGiB: string
  error: string | null
  isRunning: boolean
  pending: boolean
  saved: boolean
  memoryVariable: string | null
  memoryValue: string | undefined
  variables: Record<string, BrickVariableValue>
  view: BrickView
  onDiskLimitChange: (value: string) => void
  onReinstall: () => void
  onSubmit: React.FormEventHandler<HTMLFormElement>
  onSwap: () => void
  onVariableChange: (
    name: string,
    value: BrickVariableValue | undefined
  ) => void
}) {
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
  const memoryDefinition = memoryVariable
    ? variableDefinitions[memoryVariable]
    : undefined
  const managedFlags = javaArgsDefinition
    ? managedJavaStartupFlags(view.environment, memoryValue, variables, {
        id: view.id,
        name: view.name,
      })
    : null
  const hasFields =
    entries.length > 0 || pairVersionAndJava || Boolean(javaArgsDefinition)

  return (
    <form className="space-y-6" onSubmit={onSubmit}>
      <StartupSection
        accessory={
          <span className="font-mono text-[0.5rem] tracking-[0.08em] text-muted-foreground/60 uppercase">
            Node capacity
          </span>
        }
        description="Limits are validated against every server on this node."
        title="Resource Allocation"
      >
        <ResourceAllocationCard
          allocation={allocation}
          configuredMemoryBytes={configuredMemoryBytes}
          diskLimitGiB={diskLimitGiB}
          disabled={!canEdit || pending}
          memoryDescription={memoryDefinition?.description}
          memoryMaxLength={memoryDefinition?.rules?.maxLength}
          memoryPattern={memoryDefinition?.rules?.pattern}
          memoryRequired={memoryDefinition?.required}
          memoryValue={
            memoryDefinition?.type === "string"
              ? (memoryValue ?? "")
              : undefined
          }
          onDiskLimitChange={onDiskLimitChange}
          onMemoryChange={
            memoryDefinition?.type === "string" && memoryVariable
              ? (value) => onVariableChange(memoryVariable, value)
              : undefined
          }
        />
      </StartupSection>

      <StartupSection title="Brick Configuration">
        <div className="overflow-hidden rounded-xl border border-border/75 bg-background/45">
          <BrickSummary
            view={view}
            canEdit={canEdit}
            pending={pending}
            onReinstall={onReinstall}
            onSwap={onSwap}
          />
          {hasFields ? (
            <div className="space-y-3 border-t border-border/65 p-4">
              {entries.map(([name, definition]) => (
                <BrickVariableField
                  key={name}
                  name={name}
                  definition={definition}
                  value={variables[name]}
                  onChange={(value) => onVariableChange(name, value)}
                />
              ))}
              {pairVersionAndJava ? (
                <MinecraftJavaVersionFields
                  brickId={view.id}
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
                  variableDefinitions={variableDefinitions}
                  version={
                    typeof variables.version === "string"
                      ? variables.version
                      : ""
                  }
                />
              ) : null}
              {javaArgsDefinition ? (
                <>
                  <ManagedJavaFlagsField value={managedFlags ?? ""} />
                  <BrickVariableField
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
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {!canEdit ? (
          <p className="mr-auto text-[0.6875rem] text-muted-foreground">
            Connect the Relay and use an account with settings access to change
            Startup.
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
                : "Apply & Start"}
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
    <div className="block space-y-1.5 text-[0.625rem] font-medium text-muted-foreground">
      <span className="flex items-center justify-between gap-2">
        <span id={labelId}>Managed flags</span>
        <span className="font-mono text-[0.5rem] text-muted-foreground/55">
          ember
        </span>
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
          <p className="font-mono text-[0.5625rem] tracking-[0.14em] text-primary uppercase">
            {title}
          </p>
          {description ? (
            <p className="mt-0.5 text-[0.625rem] text-muted-foreground">
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
  canEdit,
  pending,
  onReinstall,
  onSwap,
}: {
  view: BrickView
  canEdit: boolean
  pending: boolean
  onReinstall: () => void
  onSwap: () => void
}) {
  return (
    <WorkspaceSummaryCard
      action={
        canEdit ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={onReinstall}
            >
              <RefreshCw />
              Reinstall
            </Button>
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
          </div>
        ) : null
      }
      className="rounded-none border-0 bg-transparent"
      icon={<ServerTypeIcon implementation={view.id} className="size-5" />}
      title={view.name}
      titleAccessory={
        <Badge variant="outline" className="font-mono text-[0.5625rem]">
          {view.game}
        </Badge>
      }
    >
      <p className="mt-0.5 truncate text-[0.625rem] text-muted-foreground">
        {view.description}
      </p>
      <p className="mt-1 truncate font-mono text-[0.5625rem] text-muted-foreground/70">
        {view.source}
      </p>
    </WorkspaceSummaryCard>
  )
}

function resolvedMemoryBytes(
  template: string,
  variables: Readonly<Record<string, BrickVariableValue>>
): number | null {
  const value = resolvedMemoryValue(template, variables)
  return value ? dockerMemoryBytes(value) : null
}

function resolvedMemoryValue(
  template: string,
  variables: Readonly<Record<string, BrickVariableValue>>
): string | undefined {
  const variable = brickMemoryVariable(template)
  const value = variable ? variables[variable] : template
  return typeof value === "string" ? value : undefined
}

function brickMemoryVariable(template: string): string | null {
  return (
    template.match(/^\{\{\s*variables\.([a-z][a-z0-9_]{0,47})\s*\}\}$/u)?.[1] ??
    null
  )
}

function gibibytesToBytes(value: string): number | null {
  const gibibytes = Number(value)
  if (!Number.isFinite(gibibytes) || gibibytes <= 0) return null
  const bytes = Math.round(gibibytes * 1024 ** 3)
  return Number.isSafeInteger(bytes) ? bytes : null
}

function bytesToGiBInput(bytes: number): string {
  return String(Number((bytes / 1024 ** 3).toFixed(2)))
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

const StartupBrickReinstallDialog = React.memo(
  function StartupBrickReinstallDialog({
    brickName,
    error,
    open,
    pending,
    onOpenChange,
    onConfirm,
  }: {
    brickName: string
    error: string | null
    open: boolean
    pending: boolean
    onOpenChange: (open: boolean) => void
    onConfirm: () => void
  }) {
    return (
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (pending) return
          onOpenChange(nextOpen)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reinstall {brickName}</DialogTitle>
            <DialogDescription>
              Rebuilds the container from the current Ember image. World data
              and files stay on the volume. Unsaved Startup changes are not
              applied.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="button" disabled={pending} onClick={onConfirm}>
              {pending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              {pending ? "Reinstalling…" : "Reinstall"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }
)
