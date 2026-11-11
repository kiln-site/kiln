import * as React from "react"
import type { Brick } from "@workspace/contracts"

import type { PickableBrickKind } from "@/components/brick-kinds"
import {
  BrickCatalogBrowser,
  BrickCatalogUnavailable,
  type BrickSelection,
} from "@/components/brick-selector"

// A kind whose Bricks Hearth offers as a list of its own, as a database's
// and an App's are: those Bricks to pick from, over whatever is asked of the
// one chosen.

export function OfferedBrickBrowser({
  bricks,
  children,
  disabled = false,
  emptyMessage,
  error,
  initial,
  kind,
  kinds,
  onKindChange,
  pending,
}: {
  /** The Bricks offered, once they have loaded. */
  bricks: Array<Brick> | undefined
  /** What's asked of the Brick chosen, under its details. */
  children: (brick: Brick | null) => React.ReactNode
  disabled?: boolean
  /** Shown when the catalogs offer none. */
  emptyMessage: string
  error: string | undefined
  /** The Brick to open on. Without one, the first. */
  initial?: (bricks: ReadonlyArray<Brick>) => Brick | undefined
  kind: PickableBrickKind
  kinds?: ReadonlyArray<PickableBrickKind> | undefined
  onKindChange?: ((kind: PickableBrickKind) => void) | undefined
  pending: boolean
}) {
  if (!bricks) {
    return (
      <BrickCatalogUnavailable
        error={error}
        kind={kind}
        kinds={kinds}
        pending={pending}
        onKindChange={onKindChange}
      />
    )
  }
  return (
    <LoadedBrickBrowser
      bricks={bricks}
      disabled={disabled}
      emptyMessage={emptyMessage}
      initial={initial}
      kind={kind}
      kinds={kinds}
      onKindChange={onKindChange}
    >
      {children}
    </LoadedBrickBrowser>
  )
}

function LoadedBrickBrowser({
  bricks,
  children,
  disabled,
  emptyMessage,
  initial,
  kind,
  kinds,
  onKindChange,
}: {
  bricks: Array<Brick>
  children: (brick: Brick | null) => React.ReactNode
  disabled: boolean
  emptyMessage: string
  initial: ((bricks: ReadonlyArray<Brick>) => Brick | undefined) | undefined
  kind: PickableBrickKind
  kinds: ReadonlyArray<PickableBrickKind> | undefined
  onKindChange: ((kind: PickableBrickKind) => void) | undefined
}) {
  const [selection, setSelection] = React.useState<BrickSelection | null>(
    () => {
      const brick = initial?.(bricks) ?? bricks[0]
      return brick ? { kind: "catalog", brick } : null
    }
  )
  return (
    <BrickCatalogBrowser
      kind={kind}
      kinds={kinds}
      onKindChange={onKindChange}
      relayId=""
      bricks={bricks}
      canAddCustomBrick={false}
      selection={selection}
      onSelectionChange={setSelection}
      disabled={disabled}
      className="h-full rounded-none border-0 bg-transparent"
      emptyMessage={
        bricks.length === 0 ? emptyMessage : "No bricks match these filters."
      }
      configuration={children(
        selection?.kind === "catalog" ? selection.brick : null
      )}
    />
  )
}
