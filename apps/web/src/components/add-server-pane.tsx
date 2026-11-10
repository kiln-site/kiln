import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Effect } from "effect"
import { CircleAlert, LoaderCircle, Rocket } from "lucide-react"
import {
  DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
  MAXIMUM_INSTANCE_NAME_LENGTH,
  type Brick,
} from "@workspace/contracts"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"

import {
  BrickRelayField,
  useBrickRelayReady,
} from "@/components/brick-relay-field"
import type { PickableBrickKind } from "@/components/brick-kinds"
import {
  BrickCatalogBrowser,
  BrickCatalogUnavailable,
  type BrickSelection,
} from "@/components/brick-selector"
import { defaultBrickInstanceName } from "@/lib/brick-variables"
import { relayFleetInstance } from "@/lib/relay-fleet"
import type { PersistedRelay } from "@/lib/relay-registry"
import { brickCatalogQueryOptions, queryKeys } from "@/lib/query-options"
import { applyProvisioningInstance } from "@/lib/realtime-client"
import { useIdempotencyKey } from "@/lib/use-idempotency-key"
import { createBrickInstance } from "@/server/bricks"

type CreateBrickInstanceInput = Parameters<typeof createBrickInstance>[0]

// The game servers in the Add instance dialog: the catalogs' game server
// Bricks, and the name and Relay a new one takes. What its Brick asks is
// answered on its Startup page, once it exists.
export const AddServerPane = React.memo(function AddServerPane({
  kinds,
  onClose,
  onKindChange,
}: {
  kinds: ReadonlyArray<PickableBrickKind>
  onClose: () => void
  onKindChange: (kind: PickableBrickKind) => void
}) {
  const catalogQuery = useQuery(brickCatalogQueryOptions())
  if (!catalogQuery.data) {
    return (
      <BrickCatalogUnavailable
        error={catalogQuery.error?.message}
        kind="game-server"
        kinds={kinds}
        pending={catalogQuery.isPending}
        onKindChange={onKindChange}
      />
    )
  }
  return (
    <AddServerForm
      bricks={catalogQuery.data.bricks}
      canAddCustomBrick={catalogQuery.data.canAddCustomBrick}
      customBricks={catalogQuery.data.customBricks}
      kinds={kinds}
      relays={catalogQuery.data.relays}
      onClose={onClose}
      onKindChange={onKindChange}
    />
  )
})

const AddServerForm = React.memo(function AddServerForm({
  bricks,
  canAddCustomBrick,
  customBricks,
  kinds,
  relays,
  onClose,
  onKindChange,
}: {
  bricks: Array<Brick>
  canAddCustomBrick: boolean
  customBricks: Array<Brick>
  kinds: ReadonlyArray<PickableBrickKind>
  relays: Array<PersistedRelay>
  onClose: () => void
  onKindChange: (kind: PickableBrickKind) => void
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

      applyProvisioningInstance(
        queryClient,
        relayFleetInstance(instance, relay)
      )
      onClose()
      await navigate({
        to: "/server/$serverId/startup",
        params: { serverId: instance.id },
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.bricks }),
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
      kind="game-server"
      kinds={kinds}
      onKindChange={onKindChange}
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
  const brick = selection?.kind === "catalog" ? selection.brick : null
  const { compatible: relayCompatible, connected: relayConnected } =
    useBrickRelayReady(relays, relayId, brick)

  const submittingRef = React.useRef(false)
  const idempotencyKeyFor = useIdempotencyKey()

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
    // Nothing is answered here, so nothing is sent as an answer: the Relay
    // works out each input from its rules and defaults, and refuses a value
    // those ask for that the Brick doesn't offer.
    const variables = {}
    const provisioningInput = {
      diskLimitBytes: DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
      name: name || selectionName || "New server",
      recipe,
      relayId,
      start: false,
      variables,
    }
    const idempotencyKey = idempotencyKeyFor(provisioningInput)

    submittingRef.current = true
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          onProvision({
            data: {
              ...provisioningInput,
              idempotencyKey,
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
          maxLength={MAXIMUM_INSTANCE_NAME_LENGTH}
          placeholder="Server name"
          disabled={pending}
          required
        />
      </label>
      <BrickRelayField
        brick={brick}
        disabled={pending}
        relays={relays}
        value={relayId}
        onChange={onRelayIdChange}
      />

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive light:bg-destructive/16">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          {error}
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
