import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  listInstanceFavoritesEffect,
  setInstanceFavoriteEffect,
} from "@/effect/instance-favorites"
import { runAppEffect } from "@/effect/runtime"
import { instanceFavoriteSchema } from "@/lib/instance-favorites"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
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

const favoriteInputSchema = z.strictObject({
  favorite: instanceFavoriteSchema,
  starred: z.boolean(),
})

// One statement on the person's own list, so it holds nothing; starring
// isn't audited.
const setFavorite = operation<z.infer<typeof favoriteInputSchema>>()({
  name: "instanceFavorites.set",
  doing: "Changing your favorites",
  authorize: ({ user }) => signedIn(user),
  locks: () => [],
  run: ({ context: user, input }) =>
    setInstanceFavoriteEffect(user.id, input.favorite, input.starred),
  publish: ({ context: user }) =>
    publishRealtimeChange({
      audience: { kind: "users", userIds: [user.id] },
      topics: ["favorites"],
      type: "hearth.invalidate",
    }),
})

export const setInstanceFavorite = createServerFn({ method: "POST" })
  .validator(favoriteInputSchema)
  .handler(async ({ data }) => {
    await runOperationPromise(setFavorite, data, {
      user: await requireEligibleResourceUser(),
    })
  })
