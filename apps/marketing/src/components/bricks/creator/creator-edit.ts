import * as React from "react"

import type { BrickV2 } from "@workspace/contracts"

import { setIn } from "~/components/bricks/creator/creator-state"

export type Edit = (update: (brick: BrickV2) => BrickV2) => void

type Path = ReadonlyArray<string | number>
// Declared as a method so it's checked bivariantly: one setter serves
// fields of every value type.
type Setter = { set(value: unknown): void }["set"]

// One stable setter per path, so a memoized field keeps its props while
// another field changes.
export function useSetter(edit: Edit) {
  const cache = React.useRef(new Map<string, Setter>())
  return React.useCallback(
    (...path: Path): Setter => {
      const key = path.join(".")
      let setter = cache.current.get(key)
      if (!setter) {
        setter = (value: unknown) => edit((brick) => setIn(brick, path, value))
        cache.current.set(key, setter)
      }
      return setter
    },
    [edit]
  )
}
