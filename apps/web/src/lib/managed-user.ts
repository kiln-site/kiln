import type { ManagedUser } from "@/server/users"

/** How the Users table and Manage dialog name a person's account state. */
export function stateLabel(user: Pick<ManagedUser, "state">) {
  return user.state === "pending"
    ? "Pending"
    : user.state === "disabled"
      ? "Disabled"
      : "Active"
}
