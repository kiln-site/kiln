import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  appearanceCacheCookieName,
  defaultAppearance,
  normalizeAppearanceOverride,
  resolveAppearance,
} from "@/lib/appearance"
import { selectedInstanceCookieName } from "@/lib/ui-preference-cookies"
import { publishRealtimeChange } from "@/lib/realtime-source.server"

const SIDEBAR_COOKIE_NAME = "sidebar_state"
const FILE_TREE_COLLAPSED_COOKIE_NAME = "file_tree_collapsed"
const FILE_TREE_WIDTH_COOKIE_NAME = "file_tree_width"

function readCookie(cookies: string, name: string) {
  return cookies
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

export const getUiPreferences = createServerFn({ method: "GET" }).handler(
  async () => {
    const [
      { loadAppearanceOverrideEffect, loadPlatformAppearanceDefaultEffect },
      { runAppEffect },
      { requireAuthenticatedUser },
      { hasPlatformPermission },
      { getRequestHeaders, setCookie, setResponseHeader },
    ] = await Promise.all([
      import("@/effect/appearance-preferences"),
      import("@/effect/runtime"),
      import("@/server/auth"),
      import("@/lib/access-control"),
      import("@tanstack/react-start/server"),
    ])
    const user = await requireAuthenticatedUser()
    const [appearanceOverride, platformDefault] = await Promise.all([
      runAppEffect(
        "appearancePreferences.load",
        loadAppearanceOverrideEffect(user.id)
      ),
      runAppEffect(
        "appearancePreferences.loadPlatformDefault",
        loadPlatformAppearanceDefaultEffect()
      ),
    ])
    const appearance = resolveAppearance(appearanceOverride, platformDefault)
    setCookie(appearanceCacheCookieName, JSON.stringify(appearance), {
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
      sameSite: "lax",
    })
    setResponseHeader("Cache-Control", "no-store")

    const cookies = getRequestHeaders().get("cookie") ?? ""
    const sidebarCookie = readCookie(cookies, SIDEBAR_COOKIE_NAME)
    const fileTreeCollapsedCookie = readCookie(
      cookies,
      FILE_TREE_COLLAPSED_COOKIE_NAME
    )
    const rawFileTreeWidth = Number(
      readCookie(cookies, FILE_TREE_WIDTH_COOKIE_NAME)
    )
    const fileTreeWidth =
      Number.isFinite(rawFileTreeWidth) &&
      rawFileTreeWidth >= 224 &&
      rawFileTreeWidth <= 480
        ? rawFileTreeWidth
        : null

    return {
      sidebarOpen: sidebarCookie !== "false",
      fileTreeCollapsed: fileTreeCollapsedCookie === "true",
      fileTreeWidth,
      selectedInstanceRouteId:
        readCookie(cookies, selectedInstanceCookieName) ?? null,
      appearance,
      appearanceDefault: platformDefault ?? defaultAppearance,
      canManageAppearanceDefault: hasPlatformPermission(
        user,
        "platform.appearance.manage-default"
      ),
      customAccentColor: appearanceOverride?.accentColor ?? null,
      customColors: appearanceOverride?.customColors ?? [null, null, null],
      defaultForNewUsers: platformDefault !== null,
    }
  }
)

export const updateAppearancePreferences = createServerFn({ method: "POST" })
  .validator(
    z.object({
      accentColor: z
        .string()
        .regex(/^#[\da-f]{6}$/i)
        .nullable(),
      colorScheme: z.enum(["dark", "light", "system"]),
      customColors: z
        .array(
          z
            .string()
            .regex(/^#[\da-f]{6}$/i)
            .nullable()
        )
        .max(3),
      defaultForNewUsers: z.boolean().optional(),
    })
  )
  .handler(async ({ data }) => {
    const [
      {
        loadPlatformAppearanceDefaultEffect,
        saveAppearanceOverrideEffect,
        savePlatformAppearanceDefaultEffect,
      },
      { runAppEffect },
      { requireAuthenticatedUser },
      { hasPlatformPermission },
      { setCookie, setResponseHeader },
    ] = await Promise.all([
      import("@/effect/appearance-preferences"),
      import("@/effect/runtime"),
      import("@/server/auth"),
      import("@/lib/access-control"),
      import("@tanstack/react-start/server"),
    ])
    const user = await requireAuthenticatedUser()
    const canManageAppearanceDefault = hasPlatformPermission(
      user,
      "platform.appearance.manage-default"
    )
    if (data.defaultForNewUsers !== undefined && !canManageAppearanceDefault) {
      throw new Error(
        "The platform.appearance.manage-default permission is required"
      )
    }
    const appearanceOverride = normalizeAppearanceOverride(data)
    const platformDefault = await runAppEffect(
      "appearancePreferences.loadPlatformDefault",
      loadPlatformAppearanceDefaultEffect()
    )
    const appearance = resolveAppearance(
      appearanceOverride,
      data.defaultForNewUsers === false ? null : platformDefault
    )
    await runAppEffect(
      "appearancePreferences.save",
      saveAppearanceOverrideEffect(
        crypto.randomUUID(),
        user.id,
        appearanceOverride
      )
    )
    if (data.defaultForNewUsers !== undefined) {
      await runAppEffect(
        "appearancePreferences.savePlatformDefault",
        savePlatformAppearanceDefaultEffect(
          data.defaultForNewUsers ? appearance : null
        )
      )
    }
    setCookie(appearanceCacheCookieName, JSON.stringify(appearance), {
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
      sameSite: "lax",
    })
    setResponseHeader("Cache-Control", "no-store")
    publishRealtimeChange({
      audience:
        data.defaultForNewUsers === undefined
          ? { kind: "users", userIds: [user.id] }
          : { kind: "authenticated" },
      topics: ["preferences"],
      type: "hearth.invalidate",
    })
    return {
      appearance,
      customAccentColor: appearanceOverride.accentColor,
      customColors: appearanceOverride.customColors,
      defaultForNewUsers: data.defaultForNewUsers ?? platformDefault !== null,
    }
  })
