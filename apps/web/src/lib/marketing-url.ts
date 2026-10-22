import { getRouteApi, redirect } from "@tanstack/react-router"

import { getPublicRuntimeConfig } from "@/server/runtime-config"

const rootRouteApi = getRouteApi("__root__")

/** Pages Hearth links to on Kiln's website. */
export type MarketingPage = "/privacy" | "/terms"

export function useKilnMarketingUrl(page: MarketingPage): string {
  return `${rootRouteApi.useLoaderData().marketingUrl}${page}`
}

/** Sends an old Hearth link to the page's home on Kiln's website. */
export async function redirectToMarketing(page: MarketingPage): Promise<never> {
  const { marketingUrl } = await getPublicRuntimeConfig()
  throw redirect({ href: `${marketingUrl}${page}`, statusCode: 301 })
}
