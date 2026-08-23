import { createServerFn, createServerOnlyFn } from "@tanstack/react-start"
import { z } from "zod"

const getCurrentUser = createServerOnlyFn(async () => {
  const [{ getRequestHeaders }, { getAuthenticatedUserFromHeaders }] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/auth-session"),
    ])
  return getAuthenticatedUserFromHeaders(getRequestHeaders())
})

const setDevelopmentBypass = createServerOnlyFn(async (enabled: boolean) => {
  const [{ deleteCookie, setCookie }, { DEV_BYPASS_COOKIE }] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/auth-session"),
    ])
  if (enabled) {
    setCookie(DEV_BYPASS_COOKIE, "enabled", {
      httpOnly: true,
      maxAge: 60 * 60 * 12,
      path: "/",
      sameSite: "lax",
      secure: false,
    })
  } else {
    deleteCookie(DEV_BYPASS_COOKIE, { path: "/" })
  }
})

export const getAuthState = createServerFn({ method: "GET" }).handler(
  async () => {
    const [
      { installationState },
      { developmentBypassEnabled, publicSignupEnabled },
    ] = await Promise.all([
      import("@/lib/auth-bootstrap"),
      import("@/lib/environment"),
    ])
    return {
      ...(await installationState()),
      developmentBypassEnabled: developmentBypassEnabled(),
      signupEnabled: publicSignupEnabled(),
      user: await getCurrentUser(),
    }
  }
)

export const createInitialAdministrator = createServerFn({ method: "POST" })
  .validator(
    z.object({
      displayName: z.string().trim().min(1).max(16),
      email: z.email(),
      password: z.string().min(12).max(128),
    })
  )
  .handler(async ({ data }) => {
    const { createInitialAdministrator: createAdministrator } =
      await import("@/lib/auth-bootstrap")
    return createAdministrator(data)
  })

export const replacePendingAccountEmail = createServerFn({ method: "POST" })
  .validator(
    z.object({
      currentEmail: z.email(),
      nextEmail: z.email(),
      password: z.string().min(12).max(128),
    })
  )
  .handler(async ({ data }) => {
    const { replacePendingAccountEmail: replaceEmail } =
      await import("@/lib/auth-bootstrap")
    return replaceEmail(data)
  })

export const enableDevelopmentBypass = createServerFn({
  method: "POST",
}).handler(async () => {
  const { developmentBypassEnabled } = await import("@/lib/environment")
  if (!developmentBypassEnabled()) {
    throw new Error("The development login bypass is disabled")
  }
  await setDevelopmentBypass(true)
  return { enabled: true }
})

export const disableDevelopmentBypass = createServerFn({
  method: "POST",
}).handler(async () => {
  await setDevelopmentBypass(false)
  return { enabled: false }
})

export const requireAuthenticatedUser = createServerOnlyFn(async () => {
  const user = await getCurrentUser()
  if (!user) throw new Error("Authentication required")
  return user
})
