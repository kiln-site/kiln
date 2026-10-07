import * as React from "react"

import type { ServerPickerOption } from "@/components/server-scope-picker"

export type ScheduleScopeKind = NonNullable<ServerPickerOption["kind"]>

/** One schedule target, or every target of a kind, including future ones. */
export type ScheduleScope = ServerPickerOption | { kind: ScheduleScopeKind }

export const ScheduleScopeContext = React.createContext<ScheduleScope | null>(
  null
)

export function useScheduleScope() {
  return React.useContext(ScheduleScopeContext)
}
