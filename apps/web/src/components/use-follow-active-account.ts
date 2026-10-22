import { useEffect } from "react"

import { ensuringPromise, recoverPromise } from "@/effect/promise"
import {
  activeAccountStorageKey,
  announceActiveAccount,
  getRenderedAccount,
  readActiveAccount,
  setRenderedAccount,
} from "@/lib/browser-accounts"
import { getActiveBrowserAccountId } from "@/server/browser-accounts"

const resumeCheckIntervalMs = 2_000

/**
 * Keeps a tab rendering `userId` from acting for a different account after
 * another tab switches, signs in, or signs out. Storage events wake other tabs
 * at once; a tab that regains focus also asks Hearth which account is active,
 * since storage can be unavailable or skipped by a frozen tab. Hearth refuses
 * this tab's requests meanwhile, see `rendersOtherAccount`.
 */
export function useFollowActiveAccount(userId: string | null) {
  // Set during render so requests from this tab's first effects carry it.
  setRenderedAccount(userId)
  useEffect(() => {
    setRenderedAccount(userId)
    announceActiveAccount(userId)
    const expected = userId ?? ""
    let checking = false
    let recheck = false
    let checkedAt = 0
    let trailing: ReturnType<typeof setTimeout> | undefined
    const reloadIfChanged = (active: string | null) => {
      if (active !== null && active !== expected) window.location.reload()
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === activeAccountStorageKey) reloadIfChanged(event.newValue)
    }
    const onResume = () => {
      if (document.visibilityState !== "visible") return
      reloadIfChanged(readActiveAccount())
      checkWithHearth()
    }
    // Coalesces resume events without dropping any: a resume during or just
    // after a check runs one more check once it is allowed.
    const checkWithHearth = () => {
      if (checking) {
        recheck = true
        return
      }
      const wait = checkedAt + resumeCheckIntervalMs - Date.now()
      if (wait > 0) {
        trailing ??= setTimeout(() => {
          trailing = undefined
          checkWithHearth()
        }, wait)
        return
      }
      checking = true
      void ensuringPromise(
        () =>
          recoverPromise(
            async () =>
              reloadIfChanged((await getActiveBrowserAccountId()) ?? ""),
            () => undefined
          ),
        () => {
          checking = false
          checkedAt = Date.now()
          if (recheck) {
            recheck = false
            checkWithHearth()
          }
        }
      )
    }
    window.addEventListener("storage", onStorage)
    window.addEventListener("pageshow", onResume)
    window.addEventListener("focus", onResume)
    document.addEventListener("visibilitychange", onResume)
    return () => {
      // A follower for another account may already have taken over.
      if (getRenderedAccount() === userId) setRenderedAccount(null)
      clearTimeout(trailing)
      window.removeEventListener("storage", onStorage)
      window.removeEventListener("pageshow", onResume)
      window.removeEventListener("focus", onResume)
      document.removeEventListener("visibilitychange", onResume)
    }
  }, [userId])
}
