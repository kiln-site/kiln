import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Result } from "effect"
import { Star } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { DropdownMenuItem } from "@workspace/ui/components/dropdown-menu"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { DataTableEmptyState } from "@/components/data-table"
import {
  instanceFavoriteKey,
  type InstanceFavorite,
} from "@/lib/instance-favorites"
import {
  replaceDataTableRows,
  type DataTableSource,
} from "@/lib/data-table-source"
import {
  accessCapabilitiesQueryOptions,
  instanceFavoritesQueryOptions,
  setInstanceFavoriteMutationOptions,
} from "@/lib/query-options"

const emptyFavoriteKeys: ReadonlySet<string> = new Set()

function selectFavoriteKeys(
  favorites: ReadonlyArray<InstanceFavorite>
): ReadonlySet<string> {
  return new Set(favorites.map(instanceFavoriteKey))
}

/** Keys from `instanceFavoriteKey` for every instance the user starred. */
export function useInstanceFavoriteKeys(): ReadonlySet<string> {
  const { data } = useQuery({
    ...instanceFavoritesQueryOptions(),
    select: selectFavoriteKeys,
  })
  return data ?? emptyFavoriteKeys
}

export function useIsInstanceFavorite(favorite: InstanceFavorite): boolean {
  const key = instanceFavoriteKey(favorite)
  const selectFavorite = React.useCallback(
    (favorites: ReadonlyArray<InstanceFavorite>) =>
      favorites.some((candidate) => instanceFavoriteKey(candidate) === key),
    [key]
  )
  const { data = false } = useQuery({
    ...instanceFavoritesQueryOptions(),
    select: selectFavorite,
  })
  return data
}

export function useToggleInstanceFavorite() {
  const queryClient = useQueryClient()
  return useMutation(
    setInstanceFavoriteMutationOptions(queryClient, (error) =>
      showToast({
        message: `Could not update favorites: ${error.message}`,
        type: "error",
      })
    )
  )
}

/** A yellow star sized to the surrounding text, shown only for favorites. */
export const InstanceFavoriteStar = React.memo(function InstanceFavoriteStar({
  className,
  ...favorite
}: InstanceFavorite & { className?: string }) {
  const starred = useIsInstanceFavorite(favorite)
  if (!starred) return null
  return (
    <>
      <Star
        className={cn(
          "size-[1em] shrink-0 fill-amber-400 text-amber-400",
          className
        )}
        aria-hidden="true"
      />
      <span className="sr-only">Favorite</span>
    </>
  )
})

export const InstanceFavoriteMenuItem = React.memo(
  function InstanceFavoriteMenuItem({
    favorite,
  }: {
    favorite: InstanceFavorite
  }) {
    const starred = useIsInstanceFavorite(favorite)
    const toggle = useToggleInstanceFavorite()
    const select = React.useCallback(
      () => toggle.mutate({ favorite, starred: !starred }),
      [favorite, starred, toggle]
    )

    return (
      <DropdownMenuItem onSelect={select}>
        <Star className={cn(starred && "fill-amber-400 text-amber-400")} />
        {starred ? "Remove from favorites" : "Add to favorites"}
      </DropdownMenuItem>
    )
  }
)

export const InstanceFavoriteButton = React.memo(
  function InstanceFavoriteButton(favorite: InstanceFavorite) {
    const starred = useIsInstanceFavorite(favorite)
    const toggle = useToggleInstanceFavorite()

    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-pressed={starred}
        onClick={() => toggle.mutate({ favorite, starred: !starred })}
      >
        <Star className={cn(starred && "fill-amber-400 text-amber-400")} />
        {starred ? "Favorited" : "Favorite"}
      </Button>
    )
  }
)

const unfavoriteConfirmMs = 2500

/**
 * Table star: one click favorites. Removing takes a second click so a stray
 * click on a busy table can't drop a favorite.
 */
export const InstanceFavoriteToggle = React.memo(
  function InstanceFavoriteToggle({
    id,
    kind,
    name,
    relayId,
  }: InstanceFavorite & { name: string }) {
    const favorite = React.useMemo(
      () => ({ id, kind, relayId }),
      [id, kind, relayId]
    )
    const starred = useIsInstanceFavorite(favorite)
    const toggle = useToggleInstanceFavorite()
    const [confirming, setConfirming] = React.useState(false)
    const [hovered, setHovered] = React.useState(false)

    React.useEffect(() => {
      if (!confirming) return
      const timer = window.setTimeout(
        () => setConfirming(false),
        unfavoriteConfirmMs
      )
      return () => window.clearTimeout(timer)
    }, [confirming])

    const click = React.useCallback(() => {
      if (!starred) {
        toggle.mutate({ favorite, starred: true })
      } else if (confirming) {
        setConfirming(false)
        toggle.mutate({ favorite, starred: false })
      } else {
        setConfirming(true)
      }
    }, [confirming, favorite, starred, toggle])
    const cancelConfirm = React.useCallback(() => setConfirming(false), [])

    return (
      <Tooltip open={confirming || hovered} onOpenChange={setHovered}>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={
              starred
                ? confirming
                  ? `Click again to remove ${name} from favorites`
                  : `Remove ${name} from favorites`
                : `Add ${name} to favorites`
            }
            aria-pressed={starred}
            className={cn(
              "text-muted-foreground/45 hover:text-amber-400",
              starred && "text-amber-400",
              confirming && "bg-amber-400/12 hover:bg-amber-400/18"
            )}
            onBlur={cancelConfirm}
            onClick={click}
          >
            <Star
              key={starred ? "starred" : "unstarred"}
              className={cn(
                starred && "animate-in fill-current duration-200 zoom-in-50",
                confirming && "fill-amber-400/30"
              )}
              aria-hidden="true"
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {confirming
            ? "Click again to unfavorite"
            : starred
              ? "Favorited"
              : "Add to favorites"}
        </TooltipContent>
      </Tooltip>
    )
  }
)

/** Infra tables that can be narrowed to the user's favorites. */
export type FavoritesOnlyTable = "databases" | "relays" | "servers"

const favoritesOnlyStorageKeyPrefix = "kiln:favorites-only:v1:"
const favoritesOnlyChangedEvent = "kiln:favorites-only:changed"

function readFavoritesOnly(storageKey: string | undefined): boolean {
  if (!storageKey || typeof window === "undefined") return false
  return Result.getOrElse(
    Result.try(() => window.localStorage.getItem(storageKey) === "true"),
    () => false
  )
}

function subscribeFavoritesOnly(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(favoritesOnlyStorageKeyPrefix)) listener()
  }
  window.addEventListener(favoritesOnlyChangedEvent, listener)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(favoritesOnlyChangedEvent, listener)
    window.removeEventListener("storage", onStorage)
  }
}

function serverFavoritesOnlySnapshot() {
  return false
}

/** Per-user "favorites only" switch for one infra table, kept across visits. */
export function useFavoritesOnly(
  table: FavoritesOnlyTable
): readonly [boolean, (favoritesOnly: boolean) => void] {
  const { data: userId } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) => capabilities.user.id,
  })
  const storageKey = userId
    ? `${favoritesOnlyStorageKeyPrefix}${userId}:${table}`
    : undefined
  const getSnapshot = React.useCallback(
    () => readFavoritesOnly(storageKey),
    [storageKey]
  )
  const favoritesOnly = React.useSyncExternalStore(
    subscribeFavoritesOnly,
    getSnapshot,
    serverFavoritesOnlySnapshot
  )
  const setFavoritesOnly = React.useCallback(
    (next: boolean) => {
      if (!storageKey) return
      Result.try(() => {
        if (next) window.localStorage.setItem(storageKey, "true")
        else window.localStorage.removeItem(storageKey)
        window.dispatchEvent(new Event(favoritesOnlyChangedEvent))
      })
    },
    [storageKey]
  )
  return [favoritesOnly, setFavoritesOnly] as const
}

/**
 * Narrows a table source to favorited rows while `favoritesOnly` is on. Until
 * favorites load, the table shows their loading or error state rather than an
 * empty favorites view.
 */
export function useFavoritesOnlySource<TItem>(
  source: DataTableSource<TItem>,
  favoritesOnly: boolean,
  getFavorite: (item: TItem) => InstanceFavorite
): DataTableSource<TItem> {
  // Stay unsubscribed from favorite changes while the filter is off.
  const select = React.useCallback(
    (favorites: ReadonlyArray<InstanceFavorite>) =>
      favoritesOnly ? selectFavoriteKeys(favorites) : emptyFavoriteKeys,
    [favoritesOnly]
  )
  const {
    data: favoriteKeys,
    error,
    refetch,
  } = useQuery({
    ...instanceFavoritesQueryOptions(),
    select,
  })
  const retry = React.useCallback(() => {
    void refetch()
  }, [refetch])
  return React.useMemo(() => {
    if (!favoritesOnly) return source
    if (favoriteKeys === undefined) {
      if (source.body.kind !== "ready") return source
      return {
        ...source,
        body: error ? { kind: "error", error, retry } : { kind: "loading" },
      }
    }
    return replaceDataTableRows(
      source,
      source.rows.filter((item) =>
        favoriteKeys.has(instanceFavoriteKey(getFavorite(item)))
      )
    )
  }, [error, favoriteKeys, favoritesOnly, getFavorite, retry, source])
}

export const FavoritesOnlyButton = React.memo(function FavoritesOnlyButton({
  table,
}: {
  table: FavoritesOnlyTable
}) {
  const [favoritesOnly, setFavoritesOnly] = useFavoritesOnly(table)
  const toggle = React.useCallback(
    () => setFavoritesOnly(!favoritesOnly),
    [favoritesOnly, setFavoritesOnly]
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Show favorites only"
          aria-pressed={favoritesOnly}
          className={cn(
            favoritesOnly &&
              "border-primary/45 bg-primary/8 text-primary hover:border-primary/55 hover:bg-primary/12 hover:text-primary"
          )}
          onClick={toggle}
        >
          <Star
            className={cn(favoritesOnly && "fill-amber-400 text-amber-400")}
            aria-hidden="true"
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {favoritesOnly ? "Showing favorites only" : "Show favorites only"}
      </TooltipContent>
    </Tooltip>
  )
})

const favoritesOnlyLabels: Record<
  FavoritesOnlyTable,
  { plural: string; singular: string }
> = {
  databases: { plural: "databases", singular: "database" },
  relays: { plural: "Relays", singular: "Relay" },
  servers: { plural: "servers", singular: "server" },
}

/** Empty state for a table narrowed to favorites that still has other rows. */
export function FavoritesOnlyEmptyState({
  icon,
  searchActive,
  table,
}: {
  icon: React.ReactNode
  searchActive: boolean
  table: FavoritesOnlyTable
}) {
  const [, setFavoritesOnly] = useFavoritesOnly(table)
  const { plural, singular } = favoritesOnlyLabels[table]

  return (
    <DataTableEmptyState
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setFavoritesOnly(false)}
        >
          Show all {plural}
        </Button>
      }
      description={
        <span className="block max-w-sm">
          {searchActive
            ? `Your search only covers favorite ${plural} right now.`
            : `Star a ${singular} to keep it here.`}
        </span>
      }
      icon={icon}
      title={
        searchActive
          ? `No favorite ${plural} match your search`
          : `No favorite ${plural}`
      }
    />
  )
}
