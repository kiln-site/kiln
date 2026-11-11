import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { AddServerPane } from "@/components/add-server-pane"
import {
  pickableBrickKinds,
  type PickableBrickKind,
} from "@/components/brick-kinds"
import { BrickBrowserDialog } from "@/components/brick-selector"
import { AddDatabasePane } from "@/components/database/add-database-pane"
import { infraRelayOptionsQueryOptions } from "@/lib/infra-directory"
import { canCreateGameServers } from "@/lib/navigation-destinations"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

// One dialog adds an instance of any kind that runs a Brick: pick the kind,
// pick its Brick, answer what that kind asks. Each page's Add button opens
// it on its own kind.

interface AddInstanceDialogState {
  /** The kind shown, kept while it closes. */
  kind: PickableBrickKind
  open: boolean
}

export interface AddInstanceDialogStore {
  /** Shows another kind's Bricks while open. */
  choose: (kind: PickableBrickKind) => void
  close: () => void
  getServerSnapshot: () => AddInstanceDialogState
  getSnapshot: () => AddInstanceDialogState
  /** Opens on the kind its page adds. */
  open: () => void
  subscribe: (listener: () => void) => () => void
}

export function createAddInstanceDialogStore(
  kind: PickableBrickKind
): AddInstanceDialogStore {
  const closedState: AddInstanceDialogState = { kind, open: false }
  let state = closedState
  const listeners = new Set<() => void>()

  function publish(next: AddInstanceDialogState) {
    if (next.kind === state.kind && next.open === state.open) return
    state = next
    for (const listener of listeners) listener()
  }

  return {
    choose: (next) => publish({ kind: next, open: state.open }),
    close: () => publish({ kind: state.kind, open: false }),
    getServerSnapshot: () => closedState,
    getSnapshot: () => state,
    open: () => publish({ kind, open: true }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const AddInstanceDialogHost = React.memo(function AddInstanceDialogHost({
  store,
}: {
  store: AddInstanceDialogStore
}) {
  const state = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  )
  return (
    <BrickBrowserDialog
      open={state.open}
      title="Add instance"
      onOpenChange={(open) => {
        if (!open) store.close()
      }}
    >
      <AddInstancePane kind={state.kind} store={store} />
    </BrickBrowserDialog>
  )
})

// Mounted only while the dialog is open, so what it asks for is too.
function AddInstancePane({
  kind,
  store,
}: {
  kind: PickableBrickKind
  store: AddInstanceDialogStore
}) {
  const kinds = useCreatableKinds(kind)
  const Pane = kind === "database" ? AddDatabasePane : AddServerPane
  return <Pane kinds={kinds} onClose={store.close} onKindChange={store.choose} />
}

const someRelayCreates = ({
  relays,
}: {
  relays: ReadonlyArray<{ canCreate: boolean }>
}) => relays.some((relay) => relay.canCreate)

// The kinds this person may add somewhere, and the one already shown.
function useCreatableKinds(
  shown: PickableBrickKind
): ReadonlyArray<PickableBrickKind> {
  const { data: gameServers = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: canCreateGameServers,
  })
  const { data: databases = false } = useQuery({
    ...infraRelayOptionsQueryOptions("database"),
    select: someRelayCreates,
  })
  return React.useMemo(
    () =>
      pickableBrickKinds.filter(
        (kind) =>
          kind === shown || (kind === "database" ? databases : gameServers)
      ),
    [databases, gameServers, shown]
  )
}
