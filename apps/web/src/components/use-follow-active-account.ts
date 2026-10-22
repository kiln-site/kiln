import { useEffect } from "react"

import { recoverPromise } from "@/effect/promise"
import {
  activeAccountStorageKey,
  announceActiveAccount,
  readActiveAccount,
} from "@/lib/browser-accounts"
import { getActiveBrowserAccountId } from "@/server/browser-accounts"

const resumeCheckIntervalMs = 2_000

/**
 * Keeps a tab rendering `userId` from acting for a different account after
 * another tab switches, signs in, or signs out. Storage events wake other tabs
 * at once; a tab that regains focus also asks Hearth which account is active,
 * since storage can be unavailable or skipped by a frozen tab.
 */
export function useFollowActiveAccount(userId: string | null) {
  useEffect(() => {
    announceActiveAccount(userId)
    const expected = userId ?? ""
    let checking = false
    let checkedAt = 0
    const reloadIfChanged = (active: string | null) => {
      if (active !== null && active !== expected) window.location.reload()
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === activeAccountStorageKey) reloadIfChanged(event.newValue)
    }
    const onResume = () => {
      if (document.visibilityState !== "visible") return
      reloadIfChanged(readActiveAccount())
      if (checking || Date.now() - checkedAt < resumeCheckIntervalMs) return
      checking = true
      void recoverPromise(
        async () => reloadIfChanged((await getActiveBrowserAccountId()) ?? ""),
        () => undefined
      ).finally(() => {
        checking = false
        checkedAt = Date.now()
      })
    }
    window.addEventListener("storage", onStorage)
    window.addEventListener("pageshow", onResume)
    window.addEventListener("focus", onResume)
    document.addEventListener("visibilitychange", onResume)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener("pageshow", onResume)
      window.removeEventListener("focus", onResume)
      document.removeEventListener("visibilitychange", onResume)
    }
  }, [userId])
}
