export type GlobalSection =
  | "access"
  | "activity"
  | "backups"
  | "infra"
  | "automations"
  | "settings"
  | null

export function globalSectionFromRouteId(
  routeId: string | undefined
): GlobalSection {
  if (routeId?.startsWith("/_app/infra")) return "infra"
  if (routeId?.startsWith("/_app/backups")) return "backups"
  if (routeId?.startsWith("/_app/automations")) return "automations"
  if (routeId === "/_app/activity") return "activity"
  if (routeId === "/_app/access") return "access"
  if (routeId?.startsWith("/_app/settings")) return "settings"
  return null
}
