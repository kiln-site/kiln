import * as React from "react"
import {
  useQueryClient,
  useSuspenseQuery,
  type QueryClient,
} from "@tanstack/react-query"
import {
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"

import { forkPromise, tapPromiseError } from "@/effect/promise"
import {
  accessCapabilitiesQueryOptions,
  latestReleasesQueryOptions,
  queryKeys,
  updateOverviewQueryOptions,
} from "@/lib/query-options"
import { readRelaysAfterHearth } from "@/lib/system-update-after-hearth"
import { canRefetchSystemUpdateOverview } from "@/lib/system-update-presence"
import {
  annotateUpdaterOpen,
  finishUpdaterOpen,
  startUpdaterOpen,
  traceUpdaterWork,
} from "@/lib/updater-timing"

// The dialog is large and rarely opened, so it loads after the page: when
// the browser is idle, or when first opened.
let dialogModulePromise:
  | Promise<typeof import("@/components/infra-updates-dialog")>
  | undefined
let loadedDialogModule:
  | typeof import("@/components/infra-updates-dialog")
  | null = null

function loadDialogModule() {
  dialogModulePromise ??= tapPromiseError(
    () =>
      traceUpdaterWork("module", async () => {
        const dialogModule = await import("@/components/infra-updates-dialog")
        loadedDialogModule = dialogModule
        return dialogModule
      }),
    (error) => {
      dialogModulePromise = undefined
      throw error
    }
  )
  return dialogModulePromise
}

const InfraUpdatesDialog = React.lazy(async () => ({
  default: (await loadDialogModule()).InfraUpdatesDialog,
}))

export type InfraUpdateDialogView = "changelog" | "overview"

type InfraUpdateDialogState = {
  open: boolean
  relayId: string | null
  requestId: number
  view: InfraUpdateDialogView
}

export interface InfraUpdateDialogStore {
  close: () => void
  getServerSnapshot: () => InfraUpdateDialogState
  getSnapshot: () => InfraUpdateDialogState
  open: (relayId?: string, view?: InfraUpdateDialogView) => void
  subscribe: (listener: () => void) => () => void
}

const closedUpdateDialogState: InfraUpdateDialogState = {
  open: false,
  relayId: null,
  requestId: 0,
  view: "overview",
}

const InfraUpdateDialogContext =
  React.createContext<InfraUpdateDialogStore | null>(null)

function createInfraUpdateDialogStore(): InfraUpdateDialogStore {
  let state = closedUpdateDialogState
  const listeners = new Set<() => void>()

  function publish(nextState: InfraUpdateDialogState) {
    state = nextState
    for (const listener of listeners) listener()
  }

  return {
    close: () => {
      finishUpdaterOpen("closed")
      publish({
        open: false,
        relayId: null,
        requestId: state.requestId,
        view: state.view,
      })
    },
    getServerSnapshot: () => closedUpdateDialogState,
    getSnapshot: () => state,
    open: (relayId, view = "overview") => {
      startUpdaterOpen({ "kiln.updater.view": view })
      publish({
        open: true,
        relayId: relayId ?? null,
        requestId: state.requestId + 1,
        view,
      })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function useInfraUpdateDialogStore(): InfraUpdateDialogStore {
  const store = React.useContext(InfraUpdateDialogContext)
  if (!store) {
    throw new Error(
      "useInfraUpdateDialogStore must be used inside InfraUpdateDialogProvider"
    )
  }
  return store
}

/**
 * Starts loading what the Updates dialog shows, for a control that opens it
 * to call when pointed at or focused, so it usually opens with its targets
 * already there.
 */
export function usePrefetchInfraUpdates(): () => void {
  const queryClient = useQueryClient()
  return React.useCallback(
    () => prefetchInfraUpdates(queryClient),
    [queryClient]
  )
}

function prefetchInfraUpdates(queryClient: QueryClient): void {
  forkPromise(loadDialogModule)
  // An update that's running holds the overview still.
  if (!canRefetchSystemUpdateOverview()) return
  void queryClient.prefetchQuery(updateOverviewQueryOptions())
  void queryClient.prefetchQuery(latestReleasesQueryOptions())
}

// Opens the Updates dialog over the Relays page, for the URLs that link to
// it: /infra/updates and /infra/updates/changelog.
export function OpenInfraUpdateDialog({
  view,
}: {
  view: InfraUpdateDialogView
}) {
  const navigate = useNavigate()
  const store = useInfraUpdateDialogStore()

  React.useEffect(() => {
    void navigate({ to: "/infra/relays", replace: true }).then(() => {
      store.open(undefined, view)
    })
  }, [navigate, store, view])

  return null
}

export const InfraUpdateDialogProvider = React.memo(
  function InfraUpdateDialogProvider({
    children,
  }: {
    children: React.ReactNode
  }) {
    const [store] = React.useState(() => createInfraUpdateDialogStore())
    const awayFromInfrastructure = useRouterState({
      select: (state) => !state.location.pathname.startsWith("/infra"),
    })

    React.useEffect(() => {
      if (awayFromInfrastructure && store.getSnapshot().open) store.close()
    }, [awayFromInfrastructure, store])

    return (
      <InfraUpdateDialogContext.Provider value={store}>
        {children}
        <InfraUpdatesDialogHost store={store} />
      </InfraUpdateDialogContext.Provider>
    )
  }
)

const InfraUpdatesDialogHost = React.memo(function InfraUpdatesDialogHost({
  store,
}: {
  store: InfraUpdateDialogStore
}) {
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )

  return capabilities.canUpdateRelays ? (
    <AuthorizedInfraUpdatesDialogHost store={store} />
  ) : null
})

const AuthorizedInfraUpdatesDialogHost = React.memo(
  function AuthorizedInfraUpdatesDialogHost({
    store,
  }: {
    store: InfraUpdateDialogStore
  }) {
    const router = useRouter()
    const returnToUpdater = React.useCallback(
      (relayId: string | null) => {
        void router.navigate({ to: "/infra/relays" }).then(() => {
          store.open(relayId ?? undefined)
        })
      },
      [router, store]
    )
    const handleOpenChange = React.useCallback(
      (open: boolean) => {
        if (!open) store.close()
      },
      [store]
    )
    const state = React.useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getServerSnapshot
    )
    // Each open reads its data alongside loading the dialog, not once it
    // has loaded, and the open being timed notes what was already there.
    const queryClient = useQueryClient()
    React.useEffect(() => {
      if (state.requestId === 0) return
      annotateUpdaterOpen(
        "kiln.updater.module_loaded",
        loadedDialogModule !== null
      )
      annotateUpdaterOpen(
        "kiln.updater.overview_cached",
        queryClient.getQueryData(queryKeys.updates) !== undefined
      )
      annotateUpdaterOpen(
        "kiln.updater.releases_cached",
        queryClient.getQueryData(queryKeys.latestReleases) !== undefined
      )
      prefetchInfraUpdates(queryClient)
    }, [queryClient, state.requestId])
    // Stay mounted once opened, so closing still animates.
    const [opened, setOpened] = React.useState(false)
    if (state.open && !opened) setOpened(true)
    // Relays an "Update all" held back for Hearth's update start once the
    // page it reloaded is up, from the updater, though it stays closed.
    React.useEffect(() => {
      if (readRelaysAfterHearth()) setOpened(true)
    }, [])

    React.useEffect(() => {
      const idle =
        "requestIdleCallback" in window
          ? // No timeout: forcing it during a busy startup would defeat it.
            window.requestIdleCallback(() => forkPromise(loadDialogModule))
          : undefined
      return () => {
        if (idle !== undefined) window.cancelIdleCallback(idle)
      }
    }, [])

    // Once loaded, the dialog renders directly: through React.lazy it
    // suspends on its first render even then, and React holds back
    // revealing it for up to 300ms. Chosen once, as changing it would
    // remount the dialog.
    const dialogComponent = React.useRef<React.ComponentType<
      React.ComponentProps<typeof InfraUpdatesDialog>
    > | null>(null)
    if (!opened) return null
    dialogComponent.current ??=
      loadedDialogModule?.InfraUpdatesDialog ?? InfraUpdatesDialog
    const Dialog = dialogComponent.current
    return (
      <React.Suspense fallback={null}>
        <Dialog
          initialRelayId={state.relayId}
          open={state.open}
          requestId={state.requestId}
          view={state.view}
          onRetryTarget={returnToUpdater}
          onOpenChange={handleOpenChange}
        />
      </React.Suspense>
    )
  }
)
