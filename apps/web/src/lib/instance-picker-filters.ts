import { Option, Result, Schema } from "effect"

import type { InstanceNameInstance } from "@/components/instance-name-presentation"

export type InstancePickerKind = InstanceNameInstance["kind"]

export interface InstancePickerItem {
  disabled?: boolean
  /** Set by the picker from the user's favorites. */
  favorite?: boolean
  identity: InstanceNameInstance
  key: string
  meta: string
  name: string
  /** Extra text matched by search, such as IDs or versions. */
  searchText?: string
}

export type InstancePickerFilterGroup = "favorite" | "type"

export interface InstancePickerFilter {
  group: InstancePickerFilterGroup
  id: string
  label: string
  matches: (item: InstancePickerItem) => boolean
}

export const favoriteInstancePickerFilter: InstancePickerFilter = {
  group: "favorite",
  id: "favorite",
  label: "Favorites",
  matches: (item) => item.favorite === true,
}

/**
 * Every filter the picker can offer. New flags are added here; type filters
 * only appear when a picker mixes instance types.
 */
export const instancePickerFilters: ReadonlyArray<InstancePickerFilter> = [
  {
    group: "type",
    id: "server",
    label: "Servers",
    matches: (item) => item.identity.kind === "server",
  },
  {
    group: "type",
    id: "database",
    label: "Databases",
    matches: (item) => item.identity.kind === "database",
  },
  {
    group: "type",
    id: "relay",
    label: "Relays",
    matches: (item) => item.identity.kind === "relay",
  },
  favoriteInstancePickerFilter,
]

// No type filter shows every instance type.
export const defaultInstancePickerFilterIds: ReadonlyArray<string> = []

/** Filters worth offering for this set of items. */
export function availableInstancePickerFilters(
  items: ReadonlyArray<InstancePickerItem>
): ReadonlyArray<InstancePickerFilter> {
  const kinds = new Set(items.map((item) => item.identity.kind))
  return instancePickerFilters.filter(
    (filter) =>
      filter.group !== "type" || (kinds.size > 1 && items.some(filter.matches))
  )
}

/**
 * Filters combine with OR inside a group and AND across groups, so
 * "Servers + Databases + Favorites" means favorite servers or databases.
 */
export function filterInstancePickerItems<T extends InstancePickerItem>(
  items: ReadonlyArray<T>,
  activeFilters: ReadonlyArray<InstancePickerFilter>
): ReadonlyArray<T> {
  if (activeFilters.length === 0) return items
  const groups = new Map<
    InstancePickerFilterGroup,
    Array<InstancePickerFilter>
  >()
  for (const filter of activeFilters) {
    const group = groups.get(filter.group)
    if (group) group.push(filter)
    else groups.set(filter.group, [filter])
  }
  return items.filter((item) =>
    Array.from(groups.values()).every((filters) =>
      filters.some((filter) => filter.matches(item))
    )
  )
}

const storageKeyPrefix = "kiln:instance-picker-filters:v1:"
const filtersChangedEvent = "kiln:instance-picker-filters:changed"
const decodeStoredFilterIds = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String))
)
const defaultFilterIdsSnapshot = JSON.stringify(defaultInstancePickerFilterIds)

export function instancePickerFilterIdsSnapshot(userId: string): string {
  if (typeof window === "undefined") return defaultFilterIdsSnapshot
  const stored = Result.getOrElse(
    Result.try(() => window.localStorage.getItem(storageKeyPrefix + userId)),
    () => null
  )
  return stored ?? defaultFilterIdsSnapshot
}

export function defaultInstancePickerFilterIdsSnapshot(): string {
  return defaultFilterIdsSnapshot
}

export function instancePickerFilterIdsFromSnapshot(
  snapshot: string
): ReadonlyArray<string> {
  return Option.getOrElse(
    decodeStoredFilterIds(snapshot),
    () => defaultInstancePickerFilterIds
  )
}

export function writeInstancePickerFilterIds(
  userId: string,
  filterIds: ReadonlyArray<string>
) {
  if (typeof window === "undefined") return
  Result.try(() => {
    window.localStorage.setItem(
      storageKeyPrefix + userId,
      JSON.stringify(filterIds)
    )
    window.dispatchEvent(new Event(filtersChangedEvent))
  })
}

export function subscribeInstancePickerFilterIds(
  listener: () => void
): () => void {
  if (typeof window === "undefined") return () => undefined
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(storageKeyPrefix)) listener()
  }
  window.addEventListener(filtersChangedEvent, listener)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(filtersChangedEvent, listener)
    window.removeEventListener("storage", onStorage)
  }
}
