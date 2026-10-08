import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
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

import {
  instanceFavoriteKey,
  type InstanceFavorite,
} from "@/lib/instance-favorites"
import {
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
