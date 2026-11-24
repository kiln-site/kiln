import * as React from "react"
import { useMutation } from "@tanstack/react-query"

import { recoverPromise } from "@/effect/promise"
import { restoreKiln } from "@/server/platform"

const CHECK_EVERY_MS = 2_000
// A restore that never stops Hearth failed at once; the Relay says why once
// the page is open again.
const GIVE_UP_AFTER_MS = 10 * 60_000

/**
 * Restores Kiln from a backup, or with none undoes the last restore. Hearth
 * stops meanwhile and everyone signs in again, so once it's back this opens
 * it afresh.
 */
export function useRestoreKiln() {
  const restore = useMutation({
    mutationFn: (input: { backupId: string | null; relayId: string }) =>
      restoreKiln({ data: input }),
  })
  const restoring = restore.isSuccess
  React.useEffect(() => {
    if (!restoring) return
    const startedAt = Date.now()
    let stopped = false
    const timer = window.setInterval(async () => {
      const healthy = await recoverPromise(
        async () => (await fetch("/api/health", { cache: "no-store" })).ok,
        () => false
      )
      if (!healthy) stopped = true
      if ((stopped && healthy) || Date.now() - startedAt > GIVE_UP_AFTER_MS) {
        window.clearInterval(timer)
        window.location.assign("/")
      }
    }, CHECK_EVERY_MS)
    return () => window.clearInterval(timer)
  }, [restoring])
  return {
    error: restore.error?.message ?? null,
    restore: restore.mutate,
    restoring: restoring || restore.isPending,
  }
}
