import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Effect } from "effect"
import { CircleAlert, LoaderCircle, Rocket } from "lucide-react"
import {
  DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
  type Brick,
} from "@workspace/contracts"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

import {
  BrickCatalogBrowser,
  type BrickSelection,
} from "@/components/brick-selector"
import {
  defaultBrickInstanceName,
  defaultBrickVariables,
} from "@/lib/brick-variables"
import {
  addRelayInstanceToSnapshot,
  relayInstanceRouteId,
  type RelayFleetSnapshot,
} from "@/lib/relay-fleet"
import type { PersistedRelay } from "@/lib/relay-registry"
import {
  brickCatalogQueryOptions,
  queryKeys,
  relayConnectionQueryOptions,
} from "@/lib/query-options"
import type { RelayConnection } from "@/lib/query-options"
import { createBrickInstance } from "@/server/bricks"

type AddServerDialogState = { kind: "closed" } | { kind: "open" }
type CreateBrickInstanceInput = Parameters<typeof createBrickInstance>[0]

export interface AddServerDialogStore {
  close: () => void
  getServerSnapshot: () => AddServerDialogState
  getSnapshot: () => AddServerDialogState
  open: () => void
  subscribe: (listener: () => void) => () => void
}

const closedState: AddServerDialogState = { kind: "closed" }
const NO_RELAY_OPTION_VALUE = "__no-relay-option__"

export function createAddServerDialogStore(): AddServerDialogStore {
  let state = closedState
  const listeners = new Set<() => void>()

  function publish(next: AddServerDialogState) {
    if (next === state) return
    state = next
    for (const listener of listeners) listener()
  }

  return {
    close: () => publish(closedState),
    getServerSnapshot: () => closedState,
    getSnapshot: () => state,
    open: () => publish({ kind: "open" }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const AddServerDialogHost = React.memo(function AddServerDialogHost({
  store,
}: {
  store: AddServerDialogStore
}) {
  const state = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  )
  return (
    <AddServerDialog
      open={state.kind === "open"}
      onOpenChange={(open) => {
        if (!open) store.close()
      }}
    />
  )
})

const AddServerDialog = React.memo(function AddServerDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const catalogQuery = useQuery({
    ...brickCatalogQueryOptions(),
    enabled: open,
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(36rem,calc(100dvh-2rem))] max-h-none gap-0 overflow-hidden p-0 sm:max-w-[calc(100%-2rem)] xl:max-w-5xl">
        <DialogTitle className="sr-only">Add Server</DialogTitle>
        {!catalogQuery.data ? (
          <div className="grid min-h-56 place-items-center text-center">
            {catalogQuery.isPending ? (
              <LoaderCircle className="size-5 animate-spin text-primary" />
            ) : (
              <div className="max-w-sm">
                <CircleAlert className="mx-auto size-5 text-amber-300" />
                <p className="mt-2 text-sm font-semibold">
                  Brick catalog unavailable
                </p>
                <p className="type-support mt-1 text-muted-foreground">
                  {catalogQuery.error?.message ??
                    "Connect a Relay to load verified Bricks."}
                </p>
              </div>
            )}
          </div>
        ) : (
          <AddServerForm
            bricks={catalogQuery.data.bricks}
            canAddCustomBrick={catalogQuery.data.canAddCustomBrick}
            customBricks={catalogQuery.data.customBricks}
            relays={catalogQuery.data.relays}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
})

const AddServerForm = React.memo(function AddServerForm({
  bricks,
  canAddCustomBrick,
  customBricks,
  relays,
  onClose,
}: {
  bricks: Array<Brick>
  canAddCustomBrick: boolean
  customBricks: Array<Brick>
  relays: Array<PersistedRelay>
  onClose: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [selection, setSelection] = React.useState<BrickSelection | null>(
    () => {
      const brick = bricks[0] ?? customBricks[0]
      return brick ? { kind: "catalog", brick } : null
    }
  )
  const [relayId, setRelayId] = React.useState(() => relays[0]?.id ?? "")

  const { isPending: pending, mutateAsync: provisionServer } = useMutation({
    mutationFn: createBrickInstance,
    onSuccess: async (instance, variables) => {
      const relay = relays.find((item) => item.id === variables.data.relayId)
      if (!relay) throw new Error("Provisioning Relay is no longer available")

      const addInstance = (snapshot: RelayFleetSnapshot | undefined) =>
        addRelayInstanceToSnapshot(snapshot, instance, relay)
      queryClient.setQueryData(queryKeys.relay.snapshot, addInstance)
      queryClient.setQueryData<RelayConnection>(
        queryKeys.relay.connection,
        (connection) =>
          connection?.status === "connected"
            ? { ...connection, snapshot: addInstance(connection.snapshot)! }
            : connection
      )
      onClose()
      await navigate({
        to: "/server/$serverId/startup",
        params: {
          serverId: relayInstanceRouteId(
            variables.data.relayId,
            instance.shortId
          ),
        },
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.bricks }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.relay.connection,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.relay.snapshot }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.schedules.options,
        }),
      ])
    },
  })

  const changeSelection = React.useCallback((next: BrickSelection | null) => {
    setSelection(next)
  }, [])

  return (
    <BrickCatalogBrowser
      relayId={relayId}
      bricks={bricks}
      canAddCustomBrick={canAddCustomBrick}
      customBricks={customBricks}
      selection={selection}
      onSelectionChange={changeSelection}
      disabled={pending}
      className="h-full rounded-none border-0 bg-transparent"
      configuration={
        <AddServerConfiguration
          selection={selection}
          relays={relays}
          relayId={relayId}
          onRelayIdChange={setRelayId}
          onClose={onClose}
          onProvision={provisionServer}
          pending={pending}
        />
      }
    />
  )
})

const AddServerConfiguration = React.memo(function AddServerConfiguration({
  selection,
  relays,
  relayId,
  onRelayIdChange,
  onClose,
  onProvision,
  pending,
}: {
  selection: BrickSelection | null
  relays: Array<PersistedRelay>
  relayId: string
  onRelayIdChange: (relayId: string) => void
  onClose: () => void
  onProvision: (input: CreateBrickInstanceInput) => Promise<unknown>
  pending: boolean
}) {
  const selectionName =
    selection?.kind === "catalog"
      ? defaultBrickInstanceName(selection.brick)
      : selection?.kind === "custom"
        ? "Custom server"
        : ""
  const selectionIdentity =
    selection?.kind === "catalog"
      ? selection.brick.source
      : (selection?.kind ?? "none")
  const [failure, setFailure] = React.useState<{
    selectionIdentity: string
    message: string
  } | null>(null)
  const error =
    failure?.selectionIdentity === selectionIdentity ? failure.message : null
  const compatibleRelays = relays.filter((relay) =>
    relaySupportsSelection(relay, selection)
  )
  const selectedRelay = relays.find((relay) => relay.id === relayId)
  const relayCompatible =
    selectedRelay !== undefined &&
    relaySupportsSelection(selectedRelay, selection)
  const relayConnected = useSelectedRelayConnected(relayId)

  const submittingRef = React.useRef(false)

  async function provision(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      !relayConnected ||
      !relayId ||
      !relayCompatible ||
      !selection ||
      pending ||
      submittingRef.current
    ) {
      return
    }
    setFailure(null)

    const recipe =
      selection.kind === "catalog"
        ? selection.brick.source
        : selection.source.trim()
    if (!recipe) {
      setFailure({
        selectionIdentity,
        message: "Enter a Brick recipe URL",
      })
      return
    }
    const formData = new FormData(event.currentTarget)
    const submittedName = formData.get("name")
    const name = typeof submittedName === "string" ? submittedName.trim() : ""
    const variables =
      selection.kind === "catalog" ? defaultBrickVariables(selection.brick) : {}

    submittingRef.current = true
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          onProvision({
            data: {
              diskLimitBytes: DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
              name: name || selectionName || "New server",
              recipe,
              relayId,
              start: false,
              variables,
            },
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            setFailure({
              selectionIdentity,
              message:
                cause instanceof Error ? cause.message : "Could not provision",
            })
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

  const canProvision =
    relayConnected &&
    Boolean(relayId) &&
    relayCompatible &&
    selection?.kind === "catalog" &&
    !pending

  return (
    <form className="space-y-3" onSubmit={provision}>
      <p className="type-technical-label text-muted-foreground">
        Server details
      </p>
      <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
        <span>Server name</span>
        <Input
          key={selectionIdentity}
          name="name"
          defaultValue={selectionName}
          maxLength={120}
          placeholder="Server name"
          disabled={pending}
          required
        />
      </label>
      <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
        <span>Relay</span>
        <Select
          value={relayId}
          onValueChange={(value) => {
            if (value !== NO_RELAY_OPTION_VALUE) onRelayIdChange(value)
          }}
          disabled={pending}
          required
        >
          <SelectTrigger className="h-8 w-full [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:flex-1 [&_[data-slot=select-value]]:overflow-hidden [&_[data-slot=select-value]]:text-left [&_[data-slot=select-value]]:text-ellipsis [&_[data-slot=select-value]]:whitespace-nowrap">
            <SelectValue
              placeholder={
                relays.length === 0
                  ? "No Relays available"
                  : compatibleRelays.length === 0
                    ? "No compatible Relays"
                    : "Select a Relay"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {relays.length === 0 ? (
              <SelectItem value={NO_RELAY_OPTION_VALUE} disabled>
                No Relays available
              </SelectItem>
            ) : (
              <>
                {compatibleRelays.length === 0 ? (
                  <SelectItem value={NO_RELAY_OPTION_VALUE} disabled>
                    No compatible Relays
                  </SelectItem>
                ) : null}
                {relays.map((relay) => {
                  const compatible = relaySupportsSelection(relay, selection)
                  return (
                    <SelectItem
                      key={relay.id}
                      value={relay.id}
                      disabled={!compatible}
                    >
                      {relay.name}
                      {compatible
                        ? ""
                        : ` — incompatible (${displayArchitecture(relay.nodeArch)})`}
                    </SelectItem>
                  )
                })}
              </>
            )}
          </SelectContent>
        </Select>
      </label>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      {relayCompatible && !relayConnected && relayId ? (
        <p className="text-xs leading-relaxed text-amber-300">
          Selected Relay is not connected.
        </p>
      ) : null}

      {selectedRelay && !relayCompatible ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/8 px-3 py-2 text-xs leading-relaxed text-amber-200">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {selectedRelay.name} runs{" "}
            {displayArchitecture(selectedRelay.nodeArch)}, which this Brick does
            not support. Choose a compatible Relay to provision.
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canProvision}>
          {pending ? <LoaderCircle className="animate-spin" /> : <Rocket />}
          Provision
        </Button>
      </div>
    </form>
  )
})

function useSelectedRelayConnected(relayId: string): boolean {
  const queryClient = useQueryClient()
  const selectRelayConnected = React.useCallback(
    (connection: RelayConnection) =>
      connection.status === "connected" &&
      connection.relays.some(
        (relay) => relay.id === relayId && relay.status === "connected"
      ),
    [relayId]
  )
  const { data = false } = useQuery({
    ...relayConnectionQueryOptions(queryClient),
    select: selectRelayConnected,
  })
  return data
}

function relaySupportsSelection(
  relay: PersistedRelay,
  selection: BrickSelection | null
): boolean {
  if (selection?.kind !== "catalog" || !relay.nodeArch) return true
  const architectures = selection.brick.constraints.architectures
  if (!architectures || architectures.length === 0) return true
  const relayArchitecture = normalizeArchitecture(relay.nodeArch)
  return architectures.some(
    (architecture) => normalizeArchitecture(architecture) === relayArchitecture
  )
}

function normalizeArchitecture(architecture: string): string {
  switch (architecture.trim().toLowerCase()) {
    case "x64":
    case "x86-64":
    case "x86_64":
      return "amd64"
    case "aarch64":
      return "arm64"
    default:
      return architecture.trim().toLowerCase()
  }
}

function displayArchitecture(architecture: string | null): string {
  return architecture ? normalizeArchitecture(architecture) : "unknown"
}
