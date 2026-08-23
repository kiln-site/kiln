import type { BetterAuthClientPlugin } from "better-auth/client"

import type { passwordConfirmation } from "@/lib/password-confirmation"

export function passwordConfirmationClient() {
  return {
    id: "password-confirmation",
    $InferServerPlugin: {} as ReturnType<typeof passwordConfirmation>,
  } satisfies BetterAuthClientPlugin
}
