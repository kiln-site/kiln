import { createServerFn } from "@tanstack/react-start"

import type { OperationsOverview } from "@/operations/overview.server"

// Hearth's durable operations as its operator sees them: what runs, and
// what ended. Platform administrators only.
export const getOperationsOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<OperationsOverview> => {
    const [{ requirePlatformAdministrator }, { runAppEffect }, overview] =
      await Promise.all([
        import("@/server/platform-access.server"),
        import("@/effect/runtime"),
        import("@/operations/overview.server"),
      ])
    await requirePlatformAdministrator()
    return runAppEffect(
      "operations.overview",
      overview.loadOperationsOverview()
    )
  }
)
