import type { ManagedUser } from "@/server/users"

/** How the Users table and Manage dialog name a person's account state. */
export function stateLabel(user: Pick<ManagedUser, "state">) {
  return user.state === "pending"
    ? "Pending"
    : user.state === "disabled"
      ? "Disabled"
      : "Active"
}

/** A platform role as the Users table names it; the default sort follows it. */
export function roleLabel(role: string | null | undefined) {
  return role === "admin" || role === "platform_admin"
    ? "Kiln Admin"
    : role === "relay_creator"
      ? "Relay Creator"
      : "User"
}
