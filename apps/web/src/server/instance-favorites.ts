import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  listInstanceFavoritesEffect,
  setInstanceFavoriteEffect,
} from "@/effect/instance-favorites"
import { runAppEffect } from "@/effect/runtime"
import { instanceFavoriteSchema } from "@/lib/instance-favorites"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { requireEligibleResourceUser } from "@/server/auth"

// Favorites are the user's own list, so storing a key grants nothing; views
// only show favorites for resources the user can already read.
export const getInstanceFavorites = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
    return runAppEffect(
      "instanceFavorites.list",
      listInstanceFavoritesEffect(user.id)
    )
  }
)

export const setInstanceFavorite = createServerFn({ method: "POST" })
  .validator(
    z.strictObject({
      favorite: instanceFavoriteSchema,
      starred: z.boolean(),
    })
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    await runAppEffect(
      "instanceFavorites.set",
      setInstanceFavoriteEffect(user.id, data.favorite, data.starred)
    )
    publishRealtimeChange({
      audience: { kind: "users", userIds: [user.id] },
      topics: ["favorites"],
      type: "hearth.invalidate",
    })
  })
