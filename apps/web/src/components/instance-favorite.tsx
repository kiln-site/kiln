import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Star } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { DropdownMenuItem } from "@workspace/ui/components/dropdown-menu"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import {
  instanceFavoriteKey,
  type InstanceFavorite,
} from "@/lib/instance-favorites"
import { instanceFavoritesQueryOptions } from "@/lib/query-options"
import { setInstanceFavorite } from "@/server/instance-favorites"

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
  const { queryKey } = instanceFavoritesQueryOptions()
  return useMutation({
    mutationFn: (input: { favorite: InstanceFavorite; starred: boolean }) =>
      setInstanceFavorite({ data: input }),
    onMutate: async ({ favorite, starred }) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData(queryKey)
      const key = instanceFavoriteKey(favorite)
      queryClient.setQueryData(queryKey, (current = []) => {
        const rest = current.filter(
          (candidate) => instanceFavoriteKey(candidate) !== key
        )
        return starred ? [...rest, favorite] : rest
      })
      return { previous }
    },
    onError: (error, _input, context) => {
      queryClient.setQueryData(queryKey, context?.previous)
      showToast({
        message: `Could not update favorites: ${error.message}`,
        type: "error",
      })
    },
  })
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
