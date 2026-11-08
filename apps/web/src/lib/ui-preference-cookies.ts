export const selectedInstanceCookieName = "selected_instance_id"
export const uiPreferenceCookieMaxAge = 60 * 60 * 24 * 7

export function readSelectedInstance(): string | null {
  if (typeof document === "undefined") return null

  return (
    document.cookie
      .split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${selectedInstanceCookieName}=`))
      ?.slice(selectedInstanceCookieName.length + 1) ?? null
  )
}

export function persistSelectedInstance(selection: string) {
  if (readSelectedInstance() === selection) return

  document.cookie = `${selectedInstanceCookieName}=${selection}; path=/; max-age=${uiPreferenceCookieMaxAge}; SameSite=Lax`
}
