export const selectedInstanceCookieName = "selected_instance_id"
export const uiPreferenceCookieMaxAge = 60 * 60 * 24 * 7

export function readSelectedInstanceRouteId(): string | null {
  if (typeof document === "undefined") return null

  return (
    document.cookie
      .split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${selectedInstanceCookieName}=`))
      ?.slice(selectedInstanceCookieName.length + 1) ?? null
  )
}

export function persistSelectedInstanceRouteId(routeId: string) {
  if (readSelectedInstanceRouteId() === routeId) return

  document.cookie = `${selectedInstanceCookieName}=${routeId}; path=/; max-age=${uiPreferenceCookieMaxAge}; SameSite=Lax`
}
