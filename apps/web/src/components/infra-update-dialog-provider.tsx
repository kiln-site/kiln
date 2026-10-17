import * as React from "react"
import { useSuspenseQuery } from "@tanstack/react-query"
import {
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"

import { forkPromise, tapPromiseError } from "@/effect/promise"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

// The dialog is large and rarely opened, so it loads after the page: when
// the browser is idle, or when first opened.
let dialogModulePromise:
  | Promise<typeof import("@/components/infra-updates-dialog")>
  | undefined

function loadDialogModule() {
  dialogModulePromise ??= tapPromiseError(
    () => import("@/components/infra-updates-dialog"),
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
    close: () =>
      publish({
        open: false,
        relayId: null,
        requestId: state.requestId,
        view: state.view,
      }),
    getServerSnapshot: () => closedUpdateDialogState,
    getSnapshot: () => state,
    open: (relayId, view = "overview") =>
      publish({
        open: true,
        relayId: relayId ?? null,
        requestId: state.requestId + 1,
        view,
      }),
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
    // Stay mounted once opened, so closing still animates.
    const [opened, setOpened] = React.useState(false)
    if (state.open && !opened) setOpened(true)

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

    if (!opened) return null
    return (
      <React.Suspense fallback={null}>
        <InfraUpdatesDialog
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
