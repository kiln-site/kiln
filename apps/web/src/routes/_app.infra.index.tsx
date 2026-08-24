import { createFileRoute, redirect } from "@tanstack/react-router"

import {
  accessibleInfrastructureDestinations,
  firstAccessibleAppHref,
} from "@/lib/navigation-destinations"
import { routeAccessCapabilities } from "@/lib/route-access"

export const Route = createFileRoute("/_app/infra/")({
  beforeLoad: async ({ context }) => {
    const capabilities = await routeAccessCapabilities(context.queryClient)
    const destination =
      accessibleInfrastructureDestinations(capabilities)[0]?.to ??
      firstAccessibleAppHref(capabilities)
    throw redirect({ href: destination, replace: true })
  },
})
