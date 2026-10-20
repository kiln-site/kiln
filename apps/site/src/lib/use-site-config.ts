import { getRouteApi } from "@tanstack/react-router"

import type { SiteConfig } from "~/lib/site-config"

const rootRoute = getRouteApi("__root__")

export function useSiteConfig(): SiteConfig {
  return rootRoute.useLoaderData()
}
