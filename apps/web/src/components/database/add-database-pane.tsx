import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import type { Brick } from "@workspace/contracts"

import { showToast } from "@workspace/ui/components/sonner"

import type { PickableBrickKind } from "@/components/brick-kinds"
import {
  BrickRelayField,
  useBrickRelayReady,
  type BrickRelayOption,
} from "@/components/brick-relay-field"
import {
  DatabaseBrickBrowser,
  NewDatabaseForm,
  newDatabaseInput,
  type NewDatabaseValues,
} from "@/components/database/new-database-form"
import { infraRelayOptionsQueryOptions } from "@/lib/infra-directory"
import { queryKeys } from "@/lib/query-options"
import { useIdempotencyKey } from "@/lib/use-idempotency-key"
import { createManagedDatabase } from "@/server/databases"

const NO_RELAYS: ReadonlyArray<BrickRelayOption> = []

// The databases in the Add instance dialog: the catalogs' database Bricks,
// and what a new one is asked, its Brick's questions among them. Hearth makes
// its network, volume and password, and names whatever is left blank.
export const AddDatabasePane = React.memo(function AddDatabasePane({
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
  const { data: relays = NO_RELAYS } = useQuery({
    ...infraRelayOptionsQueryOptions("database"),
    select: creatableRelays,
  })
  // The Relay chosen, and until one is, the first it can go on.
  const [chosenRelayId, setRelayId] = React.useState<string | null>(null)
  const relayId = chosenRelayId ?? relays[0]?.id ?? ""
  // Trying the same create again reuses its key, so it reuses its ID.
  const idempotencyKeyFor = useIdempotencyKey()
  const create = useMutation({
    mutationFn: (values: NewDatabaseValues) => {
      const input = { ...newDatabaseInput(values), relayId }
      return createManagedDatabase({
        data: { ...input, idempotencyKey: idempotencyKeyFor(input) },
      })
    },
    onSuccess: async (created, { name }) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.databases.all,
      })
      // A database the Relay provisions in the background opens on its
      // provisioning page instead.
      if (created.observedState !== "provisioning") {
        showToast({ message: `${name} is ready`, type: "success" })
      }
      onClose()
      await navigate({
        params: { databaseId: created.id },
        to: "/db/$databaseId/info",
      })
    },
  })

  return (
    <DatabaseBrickBrowser
      disabled={create.isPending}
      kinds={kinds}
      onKindChange={onKindChange}
    >
      {(brick) => (
        <CreateDatabaseForm
          brick={brick}
          // What went wrong creating from another Brick isn't this one's.
          error={
            create.variables?.brick === brick?.source
              ? create.error?.message
              : undefined
          }
          pending={create.isPending}
          relayId={relayId}
          relays={relays}
          onClose={onClose}
          onRelayIdChange={setRelayId}
          onSubmit={create.mutate}
        />
      )}
    </DatabaseBrickBrowser>
  )
})

function creatableRelays({
  relays,
}: {
  relays: ReadonlyArray<BrickRelayOption & { canCreate: boolean }>
}): ReadonlyArray<BrickRelayOption> {
  return relays.filter((relay) => relay.canCreate)
}

function CreateDatabaseForm({
  brick,
  error,
  onClose,
  onRelayIdChange,
  onSubmit,
  pending,
  relayId,
  relays,
}: {
  brick: Brick | null
  error: string | undefined
  onClose: () => void
  onRelayIdChange: (relayId: string) => void
  onSubmit: (values: NewDatabaseValues) => void
  pending: boolean
  relayId: string
  relays: ReadonlyArray<BrickRelayOption>
}) {
  const { compatible, connected } = useBrickRelayReady(relays, relayId, brick)
  return (
    <NewDatabaseForm
      brick={brick}
      disabled={!relayId || !compatible || !connected}
      error={error}
      pending={pending}
      submitLabel="Create"
      onClose={onClose}
      onSubmit={onSubmit}
    >
      <BrickRelayField
        brick={brick}
        disabled={pending}
        relays={relays}
        value={relayId}
        onChange={onRelayIdChange}
      />
    </NewDatabaseForm>
  )
}
