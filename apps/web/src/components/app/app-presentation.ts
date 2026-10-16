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

// By service, so they keep their order across deployments.
export function appContainers(
  app: Pick<App, "containers">
): Array<App["containers"][number]> {
  return [...app.containers].sort(
    (left, right) =>
      left.service.localeCompare(right.service) ||
      left.name.localeCompare(right.name)
  )
}

export function showAppOperationError(message: string, error: Error) {
  showToast({ message: `${message}: ${error.message}`, type: "error" })
}
