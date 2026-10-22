import { getRouteApi, redirect } from "@tanstack/react-router"

import type { KilnLegalUrls } from "@/lib/environment"
import { getPublicRuntimeConfig } from "@/server/runtime-config"

const rootRouteApi = getRouteApi("__root__")

export function useKilnLegalUrl(page: keyof KilnLegalUrls): string {
  return rootRouteApi.useLoaderData().legalUrls[page]
}

/** Sends an old Hearth link to where the page lives now. */
export async function redirectToLegalPage(
  page: keyof KilnLegalUrls
): Promise<never> {
  const { legalUrls } = await getPublicRuntimeConfig()
  // Not permanent: the destination changes with KILN_MARKETING_URL.
  throw redirect({ href: legalUrls[page] })
}
