import { createServerFn } from "@tanstack/react-start"

import { resolveMinecraftProfileEffect } from "@/effect/minecraft-profile"
import { runAppEffect } from "@/effect/runtime"
import { requireEligibleResourceUser } from "@/server/auth"

export const getMinecraftProfile = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
    return runAppEffect(
      "minecraft.profile.resolve",
      resolveMinecraftProfileEffect(user.name)
    )
  }
)
