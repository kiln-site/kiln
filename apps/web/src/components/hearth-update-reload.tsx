import * as React from "react"

import { dismissToast, showToast } from "@workspace/ui/components/sonner"

import {
  createHearthUpdateReload,
  type HearthUpdateReloadStore,
} from "@/lib/hearth-update-reload"

const reloadToastId = "hearth-update-reload"
const ReloadContext = React.createContext<HearthUpdateReloadStore | null>(null)

export function HearthUpdateReload({
  children,
  open,
  ready,
}: {
  children: React.ReactNode
  open: boolean
  ready: boolean
}) {
  const [store] = React.useState(createHearthUpdateReload)

  React.useEffect(() => {
    if (ready) return store.start()
  }, [ready, store])

  return (
    <ReloadContext.Provider value={store}>
      {children}
      <HearthReloadNotification open={open} store={store} />
    </ReloadContext.Provider>
  )
}

function HearthReloadNotification({
  open,
  store,
}: {
  open: boolean
  store: HearthUpdateReloadStore
}) {
  const seconds = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  )

  React.useEffect(() => {
    if (seconds === 0) window.location.reload()
  }, [seconds])

  React.useEffect(() => {
    if (seconds === null || open) return
    showToast({
      id: reloadToastId,
      type: "success",
      message: "Kiln has been updated",
      description:
        seconds === 0
          ? "Reload to finish updating."
          : `Reloading in ${seconds}…`,
      duration: Infinity,
      dismissible: false,
      closeButton: false,
      action: {
        label: "Reload now",
        onClick: (event) => {
          // Keep the toast if an unsaved-work prompt cancels the reload.
          event.preventDefault()
          window.location.reload()
        },
      },
    })
  }, [open, seconds])

  React.useEffect(() => {
    if (open) dismissToast(reloadToastId)
    return () => {
      dismissToast(reloadToastId)
    }
  }, [open])

  return null
}

export function HearthReloadCountdown() {
  const store = React.useContext(ReloadContext)!
  const seconds = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  )
  if (seconds === null || seconds === 0) return null
  return (
    <span aria-live="polite" className="shrink-0 tabular-nums">
      Reloading in {seconds}…
    </span>
  )
}
