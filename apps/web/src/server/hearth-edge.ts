import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"

import { requireEligibleResourceUser } from "@/server/auth"

export type HearthEdgeProvider = "cloudflare" | "vercel"

/**
 * Hearth's public address and the edge network this request came through,
 * read from the headers each provider adds on the way in.
 */
export const getHearthEdge = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireEligibleResourceUser()
    const { kilnPublicUrl } = await import("@/lib/environment")
    const headers = getRequest().headers
    const provider: HearthEdgeProvider | null = headers.has("cf-ray")
      ? "cloudflare"
      : headers.has("x-vercel-id")
        ? "vercel"
        : null
    return { host: kilnPublicUrl().host, provider }
  }
)
