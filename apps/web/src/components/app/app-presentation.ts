import type { AppSourceType } from "@workspace/contracts"

import { showToast } from "@workspace/ui/components/sonner"

import { instanceStatusPresentation } from "@/components/instance-name-presentation"
import type { getApps } from "@/server/apps"

export type AppOverview = Awaited<ReturnType<typeof getApps>>
export type App = AppOverview["apps"][number]

export const sourceTypeLabels: Record<AppSourceType, string> = {
  compose: "Compose",
  dockerfile: "Dockerfile",
  image: "Image",
}

export function appStatusPresentation(
  app: Pick<
    App,
    | "id"
    | "inventoryStatus"
    | "observedState"
    | "relayId"
    | "relayStatus"
    | "relayUpdating"
  >
) {
  return instanceStatusPresentation({ ...app, kind: "app" })
}

// Inventory says whether the app exists on its Relay; relayStatus follows
// live Relay reachability between inventory refreshes.
export function appRelayAvailable(
  app: Pick<App, "inventoryStatus" | "relayStatus">
): boolean {
  return app.inventoryStatus === "available" && app.relayStatus === "connected"
}

// Image and Dockerfile apps run one service; Compose apps one per service.
export function appServices(app: Pick<App, "containers">): Array<string> {
  return [...new Set(appContainers(app).map((container) => container.service))]
}

// The name a service answers to on the app's network, as the Relay
// aliases it: the "app" service, which image and Dockerfile apps run, takes
// the app's hostname, and any other prefixes it with its own name.
export function appServiceAddress(
  app: Pick<App, "hostname">,
  service: string
): string {
  return service === "app" ? app.hostname : `${service}.${app.hostname}`
}

// The addresses to list for an app: one per service, or just the app's
// hostname when it runs only the "app" service or nothing yet.
export function appAddresses(
  app: Pick<App, "containers" | "hostname">
): Array<{ address: string; service: string | null }> {
  const services = appServices(app)
  if (services.length === 0 || (services.length === 1 && services[0] === "app"))
    return [{ address: app.hostname, service: null }]
  return services.map((service) => ({
    address: appServiceAddress(app, service),
    service,
  }))
}

// By service, so they keep their order across deployments, and newest
// first within one, so a replacement leads while the old one winds down.
export function appContainers(
  app: Pick<App, "containers">
): Array<App["containers"][number]> {
  return [...app.containers].sort(
    (left, right) =>
      left.service.localeCompare(right.service) ||
      (right.createdAt ?? "").localeCompare(left.createdAt ?? "") ||
      left.name.localeCompare(right.name)
  )
}

export function showAppOperationError(message: string, error: Error) {
  showToast({ message: `${message}: ${error.message}`, type: "error" })
}
