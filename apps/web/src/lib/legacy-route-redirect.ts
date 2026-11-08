import { redirect } from "@tanstack/react-router"

import { getRelayConnectionState } from "@/server/relay"
import { getAuthState } from "@/server/auth"

export async function redirectLegacyPage(
  page: "console" | "files" | "info"
): Promise<never> {
  const { user } = await getAuthState()
  if (!user) {
    throw redirect({
      to: "/",
      search: { redirect: `/${page}` },
      replace: true,
    })
  }
  const connection = await getRelayConnectionState()
  if (connection.status !== "connected") {
    if (
      user.isDevelopmentBypass ||
      user.role === "admin" ||
      user.role === "relay_creator"
    ) {
      throw redirect({ to: "/infra/relays", replace: true })
    }
    throw redirect({
      to: `/server/$serverId/${page}`,
      params: { serverId: "unavailable" },
      replace: true,
    })
  }
  const [instance] = connection.snapshot.instances
  if (!instance) {
    throw redirect({ to: "/infra/servers", replace: true })
  }
  throw redirect({
    to: `/server/$serverId/${page}`,
    params: { serverId: instance.id },
    replace: true,
  })
}
