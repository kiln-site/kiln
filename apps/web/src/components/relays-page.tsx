import * as React from "react"
import { useLiveSuspenseQuery } from "@tanstack/react-db"
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Effect } from "effect"
import {
  ArchiveX,
  Check,
  CircleAlert,
  Cloud,
  Fingerprint,
  ListTodo,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { forkPromise } from "@/effect/promise"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { dismissToast, showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import {
  relayConnectionSettingsSchema,
  relayNameSchema,
  relayProxySettingsSchema,
} from "@workspace/contracts"

import { RelayToastTitle } from "@/components/relay-toast-title"
import { InstanceName } from "@/components/instance-name"
import { useInfraUpdateDialogStore } from "@/components/infra-update-dialog-provider"
import {
  WorkspaceDataTable,
  WorkspaceTableCell,
  WorkspaceTableHead,
  WorkspaceTableHeading,
  createWorkspaceTableSearchStore,
  useWorkspaceTableSearchInput,
} from "@/components/workspace-data-table"
import type { WorkspaceTableSearchStore } from "@/components/workspace-data-table"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { relaysCollectionOptions } from "@/lib/collections/relays"
import { pairingFeedbackFrom } from "@/lib/relay-pairing-errors"
import { canRefetchSystemUpdateOverview } from "@/lib/system-update-presence"
import { resetActiveBackupRunsToFirstPage } from "@/lib/backup-runs-cache"
import {
  accessCapabilitiesQueryOptions,
  queryKeys,
  relaySnapshotQueryOptions,
  relaysQueryOptions,
  updateOverviewQueryOptions,
} from "@/lib/query-options"
import {
  compareLatestReleaseVersion,
  findKilnRelease,
  isKilnReleaseVersion,
} from "@/lib/release-version"
import type { PublicKilnRelease } from "@/effect/github-releases"
import { useKilnGitRepository } from "@/lib/git-repository"
import type { PersistedRelay } from "@/lib/relay-registry"
import {
  addRelay,
  checkRelay,
  getRelayProxy,
  previewRelayPairing,
  removeRelay,
  renameRelay,
  setRelayEnabled,
  updateRelay,
  updateRelayProxy,
} from "@/server/relays"
import type { UpdateOverview } from "@/server/updates"

const relayTimestampFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "long",
  timeZone: "UTC",
})
const invitationTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
})
const minimumRelaySyncFeedbackMs = 500
const pendingRelayResumes = new Map<string, Promise<void>>()
const noOutdatedRelays: ReadonlySet<string> = new Set()
const noPublicReleases: ReadonlyArray<PublicKilnRelease> = []
const noReportedRelayVersions: ReadonlyMap<string, string | null> = new Map()
const noRelayUpdateSummary = {
  outdatedRelayIds: noOutdatedRelays,
  reportedVersions: noReportedRelayVersions,
  releases: noPublicReleases,
}

function relayProxyQueryOptions(relayId: string) {
  return queryOptions({
    queryFn: () => getRelayProxy({ data: { id: relayId } }),
    queryKey: ["relays", "proxy", relayId] as const,
    retry: false,
    staleTime: 10_000,
  })
}

interface RelayTableItem {
  hostname: string
  id: string
  name: string
  nodeArch: string | null
  nodePlatform: string | null
  nodeVersion: string | null
}

interface RelayStaticView {
  hostname: string
  name: string
  nodeArch: string | null
  nodeVersion: string | null
  port: number
  useTls: boolean
}

interface RelayIdentityView extends RelayStatusView {
  hostname: string
  name: string
}

interface RelayStatusView {
  connected: boolean
  enabled: boolean
  lastError: string | null
}

interface RelayPauseView {
  enabled: boolean
  name: string
}

interface RelayEditView {
  enabled: boolean
  hostname: string
  id: string
  name: string
  port: number
  useTls: boolean
}

interface RelayUptimeView {
  label: string
  startedAt: string | null
}

export const RelaysPage = React.memo(function RelaysPage() {
  const [searchStore] = React.useState(createWorkspaceTableSearchStore)
  const [dialogStore] = React.useState(createRelayDialogStore)
  const updateDialogStore = useInfraUpdateDialogStore()
  const { data: canReviewUpdates } = useSuspenseQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectCanReviewUpdates,
  })

  return (
    <div className="mx-auto w-full max-w-[90rem] px-3 pb-10 sm:px-5">
      <section className="overflow-hidden rounded-xl border bg-card/45">
        <RelayToolbar searchStore={searchStore} onAdd={dialogStore.openAdd} />

        <FilteredRelayTable
          canReviewUpdates={canReviewUpdates}
          searchStore={searchStore}
          onAdd={dialogStore.openAdd}
          onEdit={dialogStore.openEdit}
          onOpenUpdates={updateDialogStore.open}
        />
      </section>

      <RelayDialogHost store={dialogStore} />
    </div>
  )
})

type RelayDialogState =
  | { kind: "add" }
  | { kind: "closed" }
  | { kind: "edit"; relayId: string }

interface RelayDialogStore {
  close: () => void
  getServerSnapshot: () => RelayDialogState
  getSnapshot: () => RelayDialogState
  openAdd: () => void
  openEdit: (relayId: string) => void
  subscribe: (listener: () => void) => () => void
}

const closedRelayDialogState: RelayDialogState = { kind: "closed" }

function createRelayDialogStore(): RelayDialogStore {
  let state = closedRelayDialogState
  const listeners = new Set<() => void>()

  function publish(nextState: RelayDialogState) {
    if (nextState === state) return
    state = nextState
    for (const listener of listeners) listener()
  }

  return {
    close: () => publish(closedRelayDialogState),
    getServerSnapshot: () => closedRelayDialogState,
    getSnapshot: () => state,
    openAdd: () => publish({ kind: "add" }),
    openEdit: (relayId) => publish({ kind: "edit", relayId }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const RelayToolbar = React.memo(function RelayToolbar({
  searchStore,
  onAdd,
}: {
  searchStore: WorkspaceTableSearchStore
  onAdd: () => void
}) {
  const [mobileSearchOpen, setMobileSearchOpen] = React.useState(false)
  const searchInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (mobileSearchOpen) searchInputRef.current?.focus()
  }, [mobileSearchOpen])

  const closeMobileSearch = () => {
    searchStore.set("")
    setMobileSearchOpen(false)
  }

  return (
    <div className="flex min-w-0 items-center gap-2 border-b bg-background/25 p-3">
      <RelaySyncButton />

      {!mobileSearchOpen ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Search relays"
              aria-controls="relay-search"
              aria-expanded={false}
              className="sm:hidden"
              onClick={() => setMobileSearchOpen(true)}
            >
              <Search />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Search relays
          </TooltipContent>
        </Tooltip>
      ) : null}

      <div
        className={`${mobileSearchOpen ? "block" : "hidden"} min-w-0 flex-1 sm:block sm:max-w-md`}
      >
        <RelaySearchInput inputRef={searchInputRef} store={searchStore} />
      </div>

      {mobileSearchOpen ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Close relay search"
          className="sm:hidden"
          onClick={closeMobileSearch}
        >
          <X />
        </Button>
      ) : null}

      <div
        className={`${mobileSearchOpen ? "hidden sm:flex" : "flex"} ml-auto shrink-0 items-center gap-2`}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="outline" className="px-2 sm:px-2.5">
              <Link to="/activity" aria-label="Activity">
                <ListTodo />
                <span className="hidden sm:inline">Activity</span>
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Activity
          </TooltipContent>
        </Tooltip>
        <RelayAddButton onAdd={onAdd} />
      </div>
    </div>
  )
})

const RelayAddButton = React.memo(function RelayAddButton({
  onAdd,
}: {
  onAdd: () => void
}) {
  return (
    <Button type="button" onClick={onAdd}>
      <Plus /> Add Relay
    </Button>
  )
})

const RelayDialogHost = React.memo(function RelayDialogHost({
  store,
}: {
  store: RelayDialogStore
}) {
  const state = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  )
  const selectEditingRelay = React.useCallback(
    (relays: Array<PersistedRelay>): RelayEditView | null => {
      if (state.kind !== "edit") return null
      const relay = relays.find((item) => item.id === state.relayId)
      return relay
        ? {
            enabled: relay.enabled,
            hostname: relay.hostname,
            id: relay.id,
            name: relay.name,
            port: relay.port,
            useTls: relay.useTls,
          }
        : null
    },
    [state]
  )
  const { data: editingRelay } = useSuspenseQuery({
    ...relaysQueryOptions(),
    select: selectEditingRelay,
  })

  return (
    <>
      <AddRelayDialog
        open={state.kind === "add"}
        onOpenChange={(open) => {
          if (!open) store.close()
        }}
      />
      {editingRelay ? (
        <EditRelayDialog
          key={editingRelay.id}
          relay={editingRelay}
          open
          onOpenChange={(open) => {
            if (!open) store.close()
          }}
        />
      ) : null}
    </>
  )
})

const RelaySearchInput = React.memo(function RelaySearchInput({
  inputRef,
  store,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  store: WorkspaceTableSearchStore
}) {
  useWorkspaceTableSearchInput(inputRef, store)

  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        id="relay-search"
        type="search"
        defaultValue={store.getServerSnapshot()}
        onChange={(event) => store.set(event.currentTarget.value)}
        placeholder="Search relays"
        aria-label="Search relays"
        className="pl-9 text-base md:text-sm"
      />
    </div>
  )
})

const FilteredRelayTable = React.memo(function FilteredRelayTable({
  canReviewUpdates,
  searchStore,
  onAdd,
  onEdit,
  onOpenUpdates,
}: {
  canReviewUpdates: boolean
  searchStore: WorkspaceTableSearchStore
  onAdd: () => void
  onEdit: (relayId: string) => void
  onOpenUpdates: (relayId?: string) => void
}) {
  const { data: relays } = useLiveSuspenseQuery({
    query: (query) =>
      query
        .from({ relay: relaysCollectionOptions })
        .orderBy(({ relay }) => relay.name)
        .orderBy(({ relay }) => relay.createdAt)
        .select(({ relay }) => ({
          hostname: relay.hostname,
          id: relay.id,
          name: relay.name,
          nodeArch: relay.nodeArch,
          nodePlatform: relay.nodePlatform,
          nodeVersion: relay.nodeVersion,
        })),
  })
  const { data: updateSummary = noRelayUpdateSummary } = useQuery({
    ...updateOverviewQueryOptions(),
    enabled: () => canReviewUpdates && canRefetchSystemUpdateOverview(),
    retry: false,
    select: selectRelayUpdateSummary,
  })

  return (
    <RelayTable
      outdatedRelayIds={updateSummary.outdatedRelayIds}
      reportedVersions={updateSummary.reportedVersions}
      releases={updateSummary.releases}
      relays={relays}
      searchStore={searchStore}
      onAdd={onAdd}
      onEdit={onEdit}
      onOpenUpdates={onOpenUpdates}
    />
  )
})

const RelaySyncButton = React.memo(function RelaySyncButton() {
  const queryClient = useQueryClient()
  const [manualSyncing, setManualSyncing] = React.useState(false)
  const manualSyncingRef = React.useRef(false)
  const feedbackTimeoutRef = React.useRef<number>(undefined)
  const mountedRef = React.useRef(true)
  const { data: hasEnabledRelay } = useSuspenseQuery({
    ...relaysQueryOptions(),
    select: selectHasEnabledRelay,
  })
  const syncRelays = useMutation({
    mutationFn: async () => {
      const relays =
        queryClient.getQueryData<Array<PersistedRelay>>(queryKeys.relays) ?? []
      const checks: Array<ReturnType<typeof checkRelay>> = []
      for (const relay of relays) {
        if (relay.enabled) checks.push(checkRelay({ data: { id: relay.id } }))
      }
      const checkedRelays = await Promise.all(checks)
      updateRelayCache(queryClient, checkedRelays)
    },
    onError: (cause) => showRelayError(cause, "Could not sync Relays"),
  })
  const syncing = manualSyncing || syncRelays.isPending

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (feedbackTimeoutRef.current !== undefined) {
        window.clearTimeout(feedbackTimeoutRef.current)
      }
    }
  }, [])

  const sync = React.useCallback(() => {
    if (!hasEnabledRelay || manualSyncingRef.current) return
    manualSyncingRef.current = true
    setManualSyncing(true)
    const startedAt = performance.now()

    syncRelays.mutate(undefined, {
      onSettled: () => {
        if (!mountedRef.current) return
        const elapsed = performance.now() - startedAt
        const remaining = Math.max(0, minimumRelaySyncFeedbackMs - elapsed)
        feedbackTimeoutRef.current = window.setTimeout(() => {
          manualSyncingRef.current = false
          setManualSyncing(false)
          feedbackTimeoutRef.current = undefined
        }, remaining)
      },
    })
  }, [hasEnabledRelay, syncRelays])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Sync relays"
          aria-busy={syncing}
          disabled={syncing || !hasEnabledRelay}
          onClick={sync}
        >
          <RefreshCw className={syncing ? "animate-spin" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Sync relays
      </TooltipContent>
    </Tooltip>
  )
})

function RelayTable({
  outdatedRelayIds,
  reportedVersions,
  releases,
  relays,
  searchStore,
  onAdd,
  onEdit,
  onOpenUpdates,
}: {
  outdatedRelayIds: ReadonlySet<string>
  reportedVersions: ReadonlyMap<string, string | null>
  releases: ReadonlyArray<PublicKilnRelease>
  relays: Array<RelayTableItem>
  searchStore: WorkspaceTableSearchStore
  onAdd: () => void
  onEdit: (relayId: string) => void
  onOpenUpdates: (relayId?: string) => void
}) {
  const renderRow = React.useCallback(
    (relay: RelayTableItem) => (
      <RelayTableRow
        outdated={outdatedRelayIds.has(relay.id)}
        releases={releases}
        relayId={relay.id}
        version={reportedVersions.get(relay.id) ?? relay.nodeVersion}
        onEdit={onEdit}
        onOpenUpdates={onOpenUpdates}
      />
    ),
    [onEdit, onOpenUpdates, outdatedRelayIds, releases, reportedVersions]
  )
  const renderEmpty = React.useCallback(
    (searchActive: boolean) => (
      <EmptyRelayTable searchActive={searchActive} onAdd={onAdd} />
    ),
    [onAdd]
  )

  return (
    <WorkspaceDataTable
      getRowKey={relayRowKey}
      getSearchText={relaySearchText}
      head={<RelayTableHead />}
      items={relays}
      renderEmpty={renderEmpty}
      renderRow={renderRow}
      searchStore={searchStore}
    />
  )
}

const RelayTableHead = React.memo(function RelayTableHead() {
  return (
    <WorkspaceTableHead>
      <WorkspaceTableHeading className="w-10 px-2 sm:w-24 sm:px-3">
        <span className="sr-only sm:not-sr-only">Status</span>
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="sm:w-[16%]">
        Relay
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[10%] xl:table-cell">
        ID
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[18%] lg:table-cell">
        Host
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[12%] lg:table-cell">
        Version
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[8%] xl:table-cell">
        Arch
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-24 sm:table-cell">
        Uptime
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-[6.5rem] px-1 sm:w-28 sm:px-3">
        Actions
      </WorkspaceTableHeading>
    </WorkspaceTableHead>
  )
})

const RelayTableRow = React.memo(function RelayTableRow({
  outdated,
  releases,
  relayId,
  version,
  onEdit,
  onOpenUpdates,
}: {
  outdated: boolean
  releases: ReadonlyArray<PublicKilnRelease>
  relayId: string
  version: string | null
  onEdit: (relayId: string) => void
  onOpenUpdates: (relayId?: string) => void
}) {
  return (
    <tr className="group transition-colors hover:bg-accent/25">
      <WorkspaceTableCell className="px-2 sm:px-3">
        <RelayStatus relayId={relayId} />
      </WorkspaceTableCell>
      <RelayIdentity
        outdated={outdated}
        releases={releases}
        relayId={relayId}
        version={version}
        onOpenUpdates={onOpenUpdates}
      />
      <RelayStaticCells
        outdated={outdated}
        releases={releases}
        relayId={relayId}
        version={version}
        onOpenUpdates={onOpenUpdates}
      />
      <WorkspaceTableCell className="type-meta hidden font-mono whitespace-nowrap text-foreground sm:table-cell">
        <RelayUptime relayId={relayId} />
      </WorkspaceTableCell>
      <WorkspaceTableCell className="px-1 sm:px-3 sm:pr-3">
        <div className="flex items-center justify-end gap-1">
          <RelayEditButton relayId={relayId} onEdit={onEdit} />
          <RelayPauseButton relayId={relayId} />
          <RelayDeleteButton relayId={relayId} />
        </div>
      </WorkspaceTableCell>
    </tr>
  )
})

const RelayStaticCells = React.memo(function RelayStaticCells({
  outdated,
  releases,
  relayId,
  version,
  onOpenUpdates,
}: {
  outdated: boolean
  releases: ReadonlyArray<PublicKilnRelease>
  relayId: string
  version: string | null
  onOpenUpdates: (relayId?: string) => void
}) {
  const selectRelay = React.useCallback(
    (relays: Array<PersistedRelay>): RelayStaticView | null => {
      const relay = relays.find((item) => item.id === relayId)
      return relay
        ? {
            hostname: relay.hostname,
            name: relay.name,
            nodeArch: relay.nodeArch,
            nodeVersion: relay.nodeVersion,
            port: relay.port,
            useTls: relay.useTls,
          }
        : null
    },
    [relayId]
  )
  const { data: relay } = useQuery({
    ...relaysQueryOptions(),
    notifyOnChangeProps: ["data"],
    select: selectRelay,
  })

  if (!relay) return null
  return (
    <>
      <WorkspaceTableCell className="hidden xl:table-cell">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="type-meta inline-block cursor-default font-mono text-foreground outline-none"
            >
              {shortRelayId(relayId)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6} className="font-mono">
            {relayId}
          </TooltipContent>
        </Tooltip>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden lg:table-cell">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="type-meta block min-w-0 cursor-default truncate font-mono text-foreground outline-none"
            >
              {relay.hostname}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6} className="font-mono">
            {relay.useTls ? "https" : "http"}://{relay.hostname}:{relay.port}
          </TooltipContent>
        </Tooltip>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden lg:table-cell">
        <RelayVersion
          name={relay.name}
          outdated={outdated}
          releases={releases}
          relayId={relayId}
          version={version}
          onOpenUpdates={onOpenUpdates}
        />
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden xl:table-cell">
        <span className="type-meta font-mono text-foreground">
          {relay.nodeArch ?? "—"}
        </span>
      </WorkspaceTableCell>
    </>
  )
})

const RelayIdentity = React.memo(function RelayIdentity({
  outdated,
  releases,
  relayId,
  version,
  onOpenUpdates,
}: {
  outdated: boolean
  releases: ReadonlyArray<PublicKilnRelease>
  relayId: string
  version: string | null
  onOpenUpdates: (relayId?: string) => void
}) {
  const selectIdentity = React.useCallback(
    (relays: Array<PersistedRelay>): RelayIdentityView | null => {
      const relay = relays.find((item) => item.id === relayId)
      return relay
        ? {
            connected: relay.lastConnectedAt !== null,
            enabled: relay.enabled,
            hostname: relay.hostname,
            lastError: relay.lastError,
            name: relay.name,
          }
        : null
    },
    [relayId]
  )
  const { data: relay } = useQuery({
    ...relaysQueryOptions(),
    notifyOnChangeProps: ["data"],
    select: selectIdentity,
  })
  if (!relay) return <WorkspaceTableCell>{null}</WorkspaceTableCell>

  return (
    <WorkspaceTableCell>
      <div className="min-w-0">
        <InstanceName
          instance={{ kind: "relay", ...relay }}
          name={relay.name}
          meta={relay.hostname}
          metaClassName="font-mono"
        />
        <div className="mt-0.5 pl-[2.625rem] lg:hidden">
          <RelayVersion
            name={relay.name}
            outdated={outdated}
            releases={releases}
            relayId={relayId}
            version={version}
            onOpenUpdates={onOpenUpdates}
          />
        </div>
      </div>
    </WorkspaceTableCell>
  )
})

const RelayEditButton = React.memo(function RelayEditButton({
  relayId,
  onEdit,
}: {
  relayId: string
  onEdit: (relayId: string) => void
}) {
  const queryClient = useQueryClient()
  const selectName = React.useCallback(
    (relays: Array<PersistedRelay>) =>
      relays.find((relay) => relay.id === relayId)?.name ?? "Relay",
    [relayId]
  )
  const { data: name = "Relay" } = useQuery({
    ...relaysQueryOptions(),
    notifyOnChangeProps: ["data"],
    select: selectName,
  })
  const warmProxy = React.useCallback(() => {
    const relay = queryClient
      .getQueryData<Array<PersistedRelay>>(queryKeys.relays)
      ?.find((item) => item.id === relayId)
    if (!relay?.enabled) return
    void queryClient.prefetchQuery(relayProxyQueryOptions(relayId))
  }, [queryClient, relayId])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Edit ${name}`}
          className="text-muted-foreground hover:text-foreground"
          onFocus={warmProxy}
          onPointerEnter={warmProxy}
          onClick={() => onEdit(relayId)}
        >
          <Pencil />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Edit
      </TooltipContent>
    </Tooltip>
  )
})

const RelayPauseButton = React.memo(function RelayPauseButton({
  relayId,
}: {
  relayId: string
}) {
  const queryClient = useQueryClient()
  const pendingRef = React.useRef(false)
  const [pending, setPending] = React.useState(false)
  const selectRelay = React.useCallback(
    (relays: Array<PersistedRelay>): RelayPauseView | null => {
      const relay = relays.find((item) => item.id === relayId)
      return relay ? { enabled: relay.enabled, name: relay.name } : null
    },
    [relayId]
  )
  const { data: relay } = useQuery({
    ...relaysQueryOptions(),
    notifyOnChangeProps: ["data"],
    select: selectRelay,
  })

  async function togglePaused() {
    if (!relay || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    const relayIdentity = { id: relayId, name: relay.name }
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          relay.enabled
            ? pauseRelay(queryClient, relayIdentity)
            : resumeRelay(queryClient, relayIdentity),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            showRelayError(
              cause,
              relay.enabled ? "Could not pause Relay" : "Could not resume Relay"
            )
          )
        ),
        Effect.ensuring(
          Effect.sync(() => {
            pendingRef.current = false
            setPending(false)
          })
        )
      )
    )
  }

  if (!relay) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`${relay.enabled ? "Pause" : "Resume"} ${relay.name}`}
          disabled={pending}
          className="text-muted-foreground hover:text-foreground"
          onClick={() => void togglePaused()}
        >
          {pending ? (
            <LoaderCircle className="animate-spin" />
          ) : relay.enabled ? (
            <Pause />
          ) : (
            <Play />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {relay.enabled ? "Pause" : "Resume"}
      </TooltipContent>
    </Tooltip>
  )
})

const RelayDeleteButton = React.memo(function RelayDeleteButton({
  relayId,
}: {
  relayId: string
}) {
  const queryClient = useQueryClient()
  const pendingRef = React.useRef(false)
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [forgetBackups, setForgetBackups] = React.useState(true)
  const [removeVanityDomains, setRemoveVanityDomains] = React.useState(true)
  const selectName = React.useCallback(
    (relays: Array<PersistedRelay>) =>
      relays.find((relay) => relay.id === relayId)?.name ?? "Relay",
    [relayId]
  )
  const { data: name = "Relay" } = useQuery({
    ...relaysQueryOptions(),
    notifyOnChangeProps: ["data"],
    select: selectName,
  })
  const removeMutation = useMutation({
    mutationFn: removeRelay,
    onSuccess: async () => {
      queryClient.setQueryData<Array<PersistedRelay>>(
        queryKeys.relays,
        (current) => current?.filter((item) => item.id !== relayId)
      )
      await Promise.all([
        invalidateRelayRuntimeQueries(queryClient),
        resetActiveBackupRunsToFirstPage(queryClient),
        queryClient.invalidateQueries({ queryKey: queryKeys.domains.settings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.databases.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.access.capabilities,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.access.overview }),
      ])
    },
  })

  async function remove() {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          removeMutation.mutateAsync({
            data: { forgetBackups, id: relayId, removeVanityDomains },
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            dismissToast(relayPausedToastId(relayId))
            dismissToast(relayResumedToastId(relayId))
            dismissToast(relayResumeErrorToastId(relayId))
            setOpen(false)
            showToast({
              message:
                result.cleanupFailures.length > 0
                  ? `${name} removed, but some Hearth cleanup could not be completed`
                  : `${name} removed from Hearth`,
              type: result.cleanupFailures.length > 0 ? "warning" : "success",
            })
          })
        ),
        Effect.catch((cause) =>
          Effect.sync(() => showRelayError(cause, "Could not remove Relay"))
        ),
        Effect.ensuring(
          Effect.sync(() => {
            pendingRef.current = false
            setPending(false)
          })
        )
      )
    )
  }

  function changeOpen(nextOpen: boolean) {
    if (pending) return
    setOpen(nextOpen)
    if (nextOpen) {
      setForgetBackups(true)
      setRemoveVanityDomains(true)
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${name}`}
            disabled={pending}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={() => changeOpen(true)}
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          Remove
        </TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Remove {name}?</DialogTitle>
            <DialogDescription>
              Hearth will stop managing this Relay. Nothing on the Relay itself
              will be changed or deleted.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 bg-background/35 p-3 transition-colors hover:bg-muted/25 has-checked:border-primary/35 has-checked:bg-primary/[0.06]">
              <input
                aria-describedby={`forget-backups-description-${relayId}`}
                checked={forgetBackups}
                className="mt-0.5 size-4 shrink-0 rounded-[3px] border-input accent-primary"
                disabled={pending}
                type="checkbox"
                onChange={(event) => setForgetBackups(event.target.checked)}
              />
              <ArchiveX className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">
                  Forget all backups
                </span>
                <span
                  id={`forget-backups-description-${relayId}`}
                  className="mt-0.5 block text-xs leading-5 text-muted-foreground"
                >
                  Remove backup history from Hearth. Stored backup files on the
                  Relay are not deleted.
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 bg-background/35 p-3 transition-colors hover:bg-muted/25 has-checked:border-primary/35 has-checked:bg-primary/[0.06]">
              <input
                aria-describedby={`remove-domains-description-${relayId}`}
                checked={removeVanityDomains}
                className="mt-0.5 size-4 shrink-0 rounded-[3px] border-input accent-primary"
                disabled={pending}
                type="checkbox"
                onChange={(event) =>
                  setRemoveVanityDomains(event.target.checked)
                }
              />
              <Cloud className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">
                  Remove vanity domains
                </span>
                <span
                  id={`remove-domains-description-${relayId}`}
                  className="mt-0.5 block text-xs leading-5 text-muted-foreground"
                >
                  Delete this Relay’s managed DNS records from Cloudflare.
                  Nothing changes on the Relay.
                </span>
              </span>
            </label>
          </div>

          <DialogFooter>
            <Button
              disabled={pending}
              type="button"
              variant="ghost"
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={pending}
              type="button"
              variant="destructive"
              onClick={() => void remove()}
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              Remove Relay
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
})

const RelayStatus = React.memo(function RelayStatus({
  relayId,
}: {
  relayId: string
}) {
  const selectStatus = React.useCallback(
    (relays: Array<PersistedRelay>): RelayStatusView | null => {
      const relay = relays.find((item) => item.id === relayId)
      return relay
        ? {
            connected: relay.lastConnectedAt !== null,
            enabled: relay.enabled,
            lastError: relay.lastError,
          }
        : null
    },
    [relayId]
  )
  const { data: relay } = useQuery({
    ...relaysQueryOptions(),
    notifyOnChangeProps: ["data"],
    select: selectStatus,
  })
  if (!relay) return null

  const status = relayStatusPresentation(relay)
  const indicator = (
    <span
      aria-label={status.label}
      className={`type-label inline-flex items-center gap-1.5 ${status.text}`}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${status.dot}`} />
      <span className="hidden sm:inline">{status.label}</span>
    </span>
  )
  if (!relay.lastError) return indicator
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="cursor-default outline-none">
          {indicator}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        <span className="max-w-64 text-muted-foreground">
          {relay.lastError}
        </span>
      </TooltipContent>
    </Tooltip>
  )
})

function relayStatusPresentation(relay: RelayStatusView) {
  return !relay.enabled
    ? {
        label: "Paused",
        dot: "bg-sky-400",
        text: "text-sky-300",
      }
    : relay.lastError
      ? {
          label: "Unreachable",
          dot: "bg-destructive",
          text: "text-destructive",
        }
      : relay.connected
        ? {
            label: "Online",
            dot: "bg-emerald-400",
            text: "text-emerald-300",
          }
        : {
            label: "Offline",
            dot: "bg-muted-foreground/50",
            text: "text-muted-foreground",
          }
}

const RelayUptime = React.memo(function RelayUptime({
  relayId,
}: {
  relayId: string
}) {
  const lastStartedAtRef = React.useRef<string | null>(null)
  const selectUptime = React.useCallback(
    (snapshot: RelayFleetSnapshot): RelayUptimeView => {
      const node = snapshot.nodes.find((item) => item.relayId === relayId)
      const startedAt = node?.startedAt ?? node?.connectedAt ?? null
      if (startedAt) lastStartedAtRef.current = startedAt
      return {
        label: formatUptimeSince(lastStartedAtRef.current),
        startedAt: lastStartedAtRef.current,
      }
    },
    [relayId]
  )
  const { data } = useQuery({
    ...relaySnapshotQueryOptions(),
    notifyOnChangeProps: ["data"],
    retry: false,
    select: selectUptime,
  })
  const startedAt = data?.startedAt ?? null
  const uptime = data?.label ?? "—"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="cursor-default outline-none focus-visible:text-foreground"
        >
          {uptime}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={6}
        className="grid min-w-64 gap-2.5"
      >
        <RelayUptimeDetails relayId={relayId} startedAt={startedAt} />
      </TooltipContent>
    </Tooltip>
  )
})

const RelayUptimeDetails = React.memo(function RelayUptimeDetails({
  relayId,
  startedAt,
}: {
  relayId: string
  startedAt: string | null
}) {
  const selectConnectedAt = React.useCallback(
    (relays: Array<PersistedRelay>) => {
      const relay = relays.find((item) => item.id === relayId)
      return relay?.lastConnectedAt ?? relay?.createdAt ?? null
    },
    [relayId]
  )
  const { data: connectedAt = null } = useQuery({
    ...relaysQueryOptions(),
    notifyOnChangeProps: ["data"],
    select: selectConnectedAt,
  })
  return (
    <>
      <TooltipDetail
        label="Connected at"
        value={
          connectedAt
            ? relayTimestampFormatter.format(new Date(connectedAt))
            : "Unavailable"
        }
      />
      <TooltipDetail
        label="Relay started at"
        value={
          startedAt
            ? relayTimestampFormatter.format(new Date(startedAt))
            : "Unavailable"
        }
      />
    </>
  )
})

function TooltipDetail({ label, value }: { label: string; value: string }) {
  return (
    <span className="grid gap-0.5">
      <span className="type-technical-label text-primary">{label}</span>
      <span className="type-meta text-foreground">{value}</span>
    </span>
  )
}

function EmptyRelayTable({
  searchActive,
  onAdd,
}: {
  searchActive: boolean
  onAdd: () => void
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      <ServerCog className="size-6 text-muted-foreground/45" />
      <p className="mt-3 text-sm font-semibold">
        {searchActive ? "No relays match your search" : "No saved Relays"}
      </p>
      <p className="type-support mt-1 max-w-sm text-muted-foreground">
        {searchActive
          ? "Try a relay name, ID, hostname, architecture, or version."
          : "Pair the first Relay to start managing game servers from Hearth."}
      </p>
      {!searchActive ? (
        <Button type="button" size="sm" className="mt-4" onClick={onAdd}>
          <Plus /> Add Relay
        </Button>
      ) : null}
    </div>
  )
}

function AddRelayDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const formRef = React.useRef<HTMLFormElement>(null)
  const [pending, setPending] = React.useState(false)
  const [feedback, setFeedback] = React.useState<{
    docsHref?: string
    message: string
  } | null>(null)
  const [reviewedPairing, setReviewedPairing] = React.useState<{
    pairingUri: string
    preview: {
      controlEndpoint: string
      existingRelayName: string | null
      expiresAt: number
      managedTls: boolean
      mode: "add" | "repair"
      relayFingerprint: string
      relayName: string
    }
  } | null>(null)
  const addMutation = useMutation({
    mutationFn: addRelay,
    onSuccess: async (relay) => {
      queryClient.setQueryData<Array<PersistedRelay>>(
        queryKeys.relays,
        (current) =>
          current?.some((item) => item.id === relay.id)
            ? current.map((item) => (item.id === relay.id ? relay : item))
            : [...(current ?? []), relay]
      )
      await Promise.all([
        invalidateRelayRuntimeQueries(queryClient),
        queryClient.invalidateQueries({
          queryKey: queryKeys.access.capabilities,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.access.overview }),
      ])
    },
  })

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen && pending) return
    onOpenChange(nextOpen)
    if (!nextOpen) {
      setFeedback(null)
      setReviewedPairing(null)
      formRef.current?.reset()
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setFeedback(null)
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          if (!reviewedPairing) {
            const form = new FormData(event.currentTarget)
            const pairingUri = String(form.get("pairingUri") ?? "").trim()
            const preview = await previewRelayPairing({ data: { pairingUri } })
            setReviewedPairing({ pairingUri, preview })
            return
          }
          const relay = await addMutation.mutateAsync({
            data: { pairingUri: reviewedPairing.pairingUri },
          })
          const repaired = reviewedPairing.preview.mode === "repair"
          showToast({
            type: "success",
            message: repaired
              ? `${relay.name} repaired`
              : `${relay.name} paired`,
            description: repaired
              ? "The Relay connection was repaired without replacing its Hearth data."
              : "The Relay is now available to Hearth.",
            duration: 4_000,
          })
          onOpenChange(false)
          setFeedback(null)
          setReviewedPairing(null)
          formRef.current?.reset()
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => setFeedback(pairingFeedbackFrom(cause)))
        ),
        Effect.ensuring(Effect.sync(() => setPending(false)))
      )
    )
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <p className="type-technical-label text-primary">
            {reviewedPairing?.preview.mode === "repair"
              ? "Existing connection"
              : "New connection"}
          </p>
          <DialogTitle>
            {reviewedPairing?.preview.mode === "repair"
              ? "Repair Relay connection"
              : "Add a Relay"}
          </DialogTitle>
          <DialogDescription>
            {reviewedPairing?.preview.mode === "repair"
              ? "Verify the Relay identity before authorizing it again."
              : "Paste the one-time pairing URI printed by Relay, then verify its identity before connecting."}
          </DialogDescription>
        </DialogHeader>

        <form
          ref={formRef}
          className="space-y-4"
          onSubmit={(event) => void submit(event)}
        >
          {reviewedPairing ? (
            <PairingReview
              pairing={reviewedPairing.preview}
              onBack={() => {
                setFeedback(null)
                setReviewedPairing(null)
              }}
            />
          ) : (
            <>
              <Field
                label="Create a pairing URI"
                htmlFor="relay-pairing-command"
              >
                <Input
                  id="relay-pairing-command"
                  value="docker exec <container-id> kiln-relay pair create"
                  className="type-meta font-mono"
                  readOnly
                />
                <p className="type-meta text-muted-foreground">
                  Run this against your Relay container, then paste the returned
                  URI below.
                </p>
              </Field>

              <Field label="One-time pairing URI" htmlFor="relay-pairing-uri">
                <textarea
                  id="relay-pairing-uri"
                  name="pairingUri"
                  className="type-code min-h-32 w-full resize-y rounded-md border border-input bg-background/35 px-3 py-2 shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                  placeholder="kiln-relay://pair/v1?payload=…"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </Field>
            </>
          )}

          {feedback ? (
            <DialogFeedback
              message={feedback.message}
              docsHref={feedback.docsHref}
            />
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <LoaderCircle className="animate-spin" /> : <Check />}
              {reviewedPairing?.preview.mode === "repair"
                ? "Repair connection"
                : reviewedPairing
                  ? "Confirm and pair"
                  : "Review pairing"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PairingReview({
  pairing,
  onBack,
}: {
  pairing: {
    controlEndpoint: string
    existingRelayName: string | null
    expiresAt: number
    managedTls: boolean
    mode: "add" | "repair"
    relayFingerprint: string
    relayName: string
  }
  onBack: () => void
}) {
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/[0.045] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
            <Fingerprint className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="type-technical-label text-primary">Verify identity</p>
            <p className="mt-0.5 truncate text-sm font-semibold">
              {pairing.relayName}
            </p>
          </div>
        </div>
        <Button type="button" size="xs" variant="ghost" onClick={onBack}>
          <X /> Back
        </Button>
      </div>
      {pairing.mode === "repair" ? (
        <div className="mt-4 flex gap-2.5 rounded-md border border-primary/20 bg-background/55 p-3">
          <RefreshCw className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <div>
            <p className="type-label text-foreground">
              Existing Relay identity found
            </p>
            <p className="type-meta mt-1 text-muted-foreground">
              Hearth will repair{" "}
              <span className="font-medium text-foreground">
                {pairing.existingRelayName ?? pairing.relayName}
              </span>{" "}
              in place. Server records, file activity, pins, and access stay
              attached.
            </p>
          </div>
        </div>
      ) : null}
      <dl className="type-meta mt-4 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Relay fingerprint</dt>
          <dd className="mt-1 font-mono break-all text-foreground">
            {pairing.relayFingerprint}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Control endpoint</dt>
          <dd className="mt-1 font-mono break-all text-foreground">
            {pairing.controlEndpoint}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">TLS trust</dt>
          <dd className="mt-1 text-foreground">
            {pairing.managedTls ? "Relay-managed CA" : "System trust"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Invitation expires</dt>
          <dd className="mt-1 text-foreground">
            {invitationTimeFormatter.format(new Date(pairing.expiresAt))}
          </dd>
        </div>
      </dl>
    </div>
  )
}

function EditRelayDialog({
  relay,
  open,
  onOpenChange,
}: {
  relay: RelayEditView
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [pending, setPending] = React.useState(false)
  const [feedback, setFeedback] = React.useState<string | null>(null)
  const updateConnection = useMutation({
    mutationFn: updateRelay,
    onSuccess: async (updatedRelay) => {
      updateRelayCache(queryClient, [updatedRelay])
      await invalidateRelayRuntimeQueries(queryClient)
    },
  })
  const updateName = useMutation({
    mutationFn: renameRelay,
    onSuccess: async (updatedRelay) => {
      updateRelayCache(queryClient, [updatedRelay])
      await invalidateRelayRuntimeQueries(queryClient)
    },
  })
  const updateProxy = useMutation({
    mutationFn: updateRelayProxy,
    onSuccess: (result) =>
      queryClient.setQueryData(
        relayProxyQueryOptions(relay.id).queryKey,
        result
      ),
  })

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setFeedback(null)

    // These values live in separate Hearth and Relay stores, so validate the
    // complete form before starting the intentionally sequential updates.
    const parsedName = relayNameSchema.safeParse(form.get("name"))
    if (!parsedName.success) {
      setFeedback(parsedName.error.issues[0]?.message ?? "Enter a Relay name")
      return
    }
    const parsedConnection = relayConnectionSettingsSchema.safeParse({
      hostname: form.get("hostname"),
      port: Number(form.get("port")),
      useTls: relay.useTls,
    })
    if (!parsedConnection.success) {
      setFeedback(
        parsedConnection.error.issues[0]?.message ??
          "Enter valid connection settings"
      )
      return
    }
    const proxy = relay.enabled
      ? queryClient.getQueryData(relayProxyQueryOptions(relay.id).queryKey)
      : undefined
    if (relay.enabled && !proxy) {
      setFeedback("Proxy configuration is still loading. Try again shortly.")
      return
    }
    const parsedProxy =
      relay.enabled && proxy
        ? relayProxySettingsSchema.safeParse({
            acmeEmail: proxy.settings.acmeEmail,
            mode: relayProxyMode(form.get("mode")),
            traefikImage: form.get("traefikImage"),
          })
        : null
    if (parsedProxy && !parsedProxy.success) {
      setFeedback(
        parsedProxy.error.issues[0]?.message ?? "Enter valid proxy settings"
      )
      return
    }

    setPending(true)
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          if (parsedName.data !== relay.name) {
            await updateName.mutateAsync({
              data: { name: parsedName.data, relayId: relay.id },
            })
          }
          await updateConnection.mutateAsync({
            data: {
              id: relay.id,
              ...parsedConnection.data,
            },
          })
          if (parsedProxy?.success) {
            await updateProxy.mutateAsync({
              data: {
                relayId: relay.id,
                ...parsedProxy.data,
              },
            })
          }
          showToast({
            type: "success",
            message: `${parsedName.data} updated`,
            description: "Relay connection settings were saved.",
            duration: 4_000,
          })
          onOpenChange(false)
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            setFeedback(messageFrom(cause, "Could not update Relay"))
          )
        ),
        Effect.ensuring(Effect.sync(() => setPending(false)))
      )
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => !pending && onOpenChange(nextOpen)}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <p className="type-technical-label text-primary">Edit connection</p>
          <DialogTitle>{relay.name}</DialogTitle>
          <DialogDescription>
            Update the Relay identity, control endpoint, and edge proxy
            configuration.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="type-meta rounded-md border border-border/70 bg-background/35 px-3 py-2 font-mono text-muted-foreground">
            Relay ID <span className="ml-1 text-foreground">{relay.id}</span>
          </div>

          <Field label="Relay name" htmlFor={`relay-name-${relay.id}`}>
            <Input
              id={`relay-name-${relay.id}`}
              name="name"
              defaultValue={relay.name}
              maxLength={120}
              required
            />
          </Field>

          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <Field label="Hostname" htmlFor={`relay-hostname-${relay.id}`}>
              <Input
                id={`relay-hostname-${relay.id}`}
                name="hostname"
                defaultValue={relay.hostname}
                placeholder="relay.example.com"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            </Field>
            <Field label="Port" htmlFor={`relay-port-${relay.id}`}>
              <Input
                id={`relay-port-${relay.id}`}
                name="port"
                defaultValue={String(relay.port)}
                type="number"
                min={1}
                max={65_535}
                required
              />
            </Field>
          </div>

          <div className="border-t border-border/70 pt-4">
            <p className="type-technical-label mb-3 text-primary">Proxy</p>
            <RelayProxyFields relayEnabled={relay.enabled} relayId={relay.id} />
          </div>

          {feedback ? <DialogFeedback message={feedback} /> : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <RelayEditSubmitButton
              pending={pending}
              relayEnabled={relay.enabled}
              relayId={relay.id}
            />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const RelayProxyFields = React.memo(function RelayProxyFields({
  relayEnabled,
  relayId,
}: {
  relayEnabled: boolean
  relayId: string
}) {
  const proxy = useQuery({
    ...relayProxyQueryOptions(relayId),
    enabled: relayEnabled,
  })

  if (relayEnabled && proxy.isPending) {
    return (
      <div className="type-meta flex h-20 items-center justify-center gap-2 rounded-md border border-border/70 bg-background/25 text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" /> Reading proxy
        configuration…
      </div>
    )
  }
  if (relayEnabled && proxy.error) {
    return (
      <DialogFeedback
        message={messageFrom(proxy.error, "Could not read proxy configuration")}
      />
    )
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Proxy mode" htmlFor={`relay-proxy-mode-${relayId}`}>
          <Select
            name="mode"
            defaultValue={proxy.data?.settings.mode ?? "none"}
            disabled={!relayEnabled}
          >
            <SelectTrigger
              id={`relay-proxy-mode-${relayId}`}
              className="type-control-sm h-8 w-full [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None / existing Traefik</SelectItem>
              <SelectItem value="hearth">Hearth proxy</SelectItem>
              <SelectItem value="traefik">Bundled Traefik</SelectItem>
              <SelectItem value="coolify">Coolify Traefik</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Traefik image" htmlFor={`traefik-image-${relayId}`}>
          <Input
            id={`traefik-image-${relayId}`}
            name="traefikImage"
            defaultValue={proxy.data?.settings.traefikImage ?? ""}
            placeholder="traefik:v3.6"
            disabled={!relayEnabled}
            required={relayEnabled}
          />
        </Field>
      </div>
      {!relayEnabled ? (
        <p className="type-meta mt-2 text-sky-300">
          Resume this Relay to edit its proxy configuration.
        </p>
      ) : null}
    </>
  )
})

const RelayEditSubmitButton = React.memo(function RelayEditSubmitButton({
  pending,
  relayEnabled,
  relayId,
}: {
  pending: boolean
  relayEnabled: boolean
  relayId: string
}) {
  const proxy = useQuery({
    ...relayProxyQueryOptions(relayId),
    enabled: relayEnabled,
    notifyOnChangeProps: ["data", "error", "isPending"],
  })

  return (
    <Button
      type="submit"
      disabled={
        pending || (relayEnabled && (proxy.isPending || Boolean(proxy.error)))
      }
    >
      {pending ? <LoaderCircle className="animate-spin" /> : <Check />}
      Save changes
    </Button>
  )
})

function DialogFeedback({
  docsHref,
  message,
}: {
  docsHref?: string
  message: string
}) {
  return (
    <div
      role="status"
      className="type-meta flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-destructive"
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 space-y-1">
        <p>{message}</p>
        {docsHref ? (
          <a
            href={docsHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex font-medium underline underline-offset-2 hover:text-destructive/80"
          >
            Docs
          </a>
        ) : null}
      </div>
    </div>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="type-label block text-muted-foreground"
      >
        {label}
      </label>
      {children}
    </div>
  )
}

function selectHasEnabledRelay(relays: Array<PersistedRelay>): boolean {
  return relays.some((relay) => relay.enabled)
}

function selectCanReviewUpdates(capabilities: {
  canUpdateRelays: boolean
}): boolean {
  return capabilities.canUpdateRelays
}

function selectRelayUpdateSummary(overview: UpdateOverview): {
  outdatedRelayIds: ReadonlySet<string>
  reportedVersions: ReadonlyMap<string, string | null>
  releases: ReadonlyArray<PublicKilnRelease>
} {
  const latestRelease = overview.releases[0]
  const outdatedRelayIds = new Set<string>()
  const reportedVersions = new Map<string, string | null>()
  for (const relay of overview.relays) {
    reportedVersions.set(relay.relayId, relay.currentVersion)
    if (
      latestRelease &&
      isKilnReleaseVersion(relay.currentVersion) &&
      compareLatestReleaseVersion(relay.currentVersion, overview.releases) === 1
    ) {
      outdatedRelayIds.add(relay.relayId)
    }
  }
  return {
    outdatedRelayIds,
    reportedVersions,
    releases: overview.releases,
  }
}

function relaySearchText(relay: RelayTableItem): string {
  return [
    relay.name,
    relay.id,
    relay.hostname,
    relay.nodeArch ?? "",
    relay.nodePlatform ?? "",
    relay.nodeVersion ?? "",
  ]
    .join(" ")
    .toLowerCase()
}

function relayRowKey(relay: RelayTableItem): string {
  return relay.id
}

function shortRelayId(id: string): string {
  return id.slice(0, 7)
}

function isGitCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value)
}

function RelayVersion({
  name,
  outdated,
  releases,
  relayId,
  version,
  onOpenUpdates,
}: {
  name: string
  outdated: boolean
  releases: ReadonlyArray<PublicKilnRelease>
  relayId: string
  version: string | null
  onOpenUpdates: (relayId?: string) => void
}) {
  const gitRepository = useKilnGitRepository()
  const release = findKilnRelease(releases, version)
  const versionLabel = !version ? (
    <span className="type-meta truncate font-mono text-foreground">—</span>
  ) : release ? (
    <a
      href={release.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`View ${release.name} on GitHub`}
      title={`${release.name} (${release.tag})`}
      className="type-label truncate text-primary transition-colors hover:text-primary focus-visible:text-primary focus-visible:outline-none"
    >
      {release.name}
    </a>
  ) : isGitCommitSha(version) ? (
    <a
      href={`${gitRepository}/commit/${version}`}
      target="_blank"
      rel="noreferrer"
      aria-label={`View Relay commit ${version}`}
      className="type-meta truncate font-mono text-primary transition-colors hover:text-primary focus-visible:text-primary focus-visible:outline-none"
    >
      {version.slice(0, 7)}
    </a>
  ) : (
    <span className="type-meta truncate font-mono text-foreground">
      {version}
    </span>
  )

  return (
    <div className="flex min-w-0 items-center gap-1">
      {versionLabel}
      {outdated ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={`Update ${name} to the latest release`}
              className="shrink-0 rounded-sm text-amber-400 transition-colors hover:text-amber-300 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              type="button"
              onClick={() => onOpenUpdates(relayId)}
            >
              <TriangleAlert className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Update available
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—"
  if (seconds < 60) return `${Math.floor(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function formatUptimeSince(startedAt: string | null): string {
  if (!startedAt) return "—"
  const timestamp = Date.parse(startedAt)
  if (!Number.isFinite(timestamp)) return "—"
  return formatUptime(Math.max(0, Math.floor((Date.now() - timestamp) / 1_000)))
}

function relayProxyMode(value: FormDataEntryValue | null) {
  if (value === "coolify") return "coolify"
  if (value === "traefik") return "traefik"
  if (value === "hearth") return "hearth"
  return "none"
}

function updateRelayCache(
  queryClient: QueryClient,
  updatedRelays: Array<PersistedRelay>
) {
  if (updatedRelays.length === 0) return
  const updates = new Map(updatedRelays.map((relay) => [relay.id, relay]))
  queryClient.setQueryData<Array<PersistedRelay>>(
    queryKeys.relays,
    (current) =>
      current?.map((relay) => updates.get(relay.id) ?? relay) ?? updatedRelays
  )
}

async function invalidateRelayRuntimeQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeys.relay.connection,
      exact: true,
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.relay.snapshot,
      exact: true,
    }),
  ])
}

async function pauseRelay(
  queryClient: QueryClient,
  relay: Pick<PersistedRelay, "id" | "name">
): Promise<void> {
  await queryClient.cancelQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] === queryKeys.relay.all[0] &&
      (queryKey[1] === queryKeys.relay.connection[1] ||
        queryKey[1] === queryKeys.relay.snapshot[1] ||
        queryKey[1] === relay.id),
  })
  const updatedRelay = await setRelayEnabled({
    data: { enabled: false, id: relay.id },
  })
  updateRelayCache(queryClient, [updatedRelay])
  await invalidateRelayRuntimeQueries(queryClient)
  dismissToast(relayResumedToastId(relay.id))
  showPausedRelayToast(queryClient, relay)
}

async function resumeRelay(
  queryClient: QueryClient,
  relay: Pick<PersistedRelay, "id" | "name">
): Promise<void> {
  const existing = pendingRelayResumes.get(relay.id)
  if (existing) return existing
  dismissToast(relayResumeErrorToastId(relay.id))
  const pending = performRelayResume(queryClient, relay)
  pendingRelayResumes.set(relay.id, pending)
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => pending,
      catch: (cause) => cause,
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (pendingRelayResumes.get(relay.id) === pending)
            pendingRelayResumes.delete(relay.id)
        })
      )
    )
  )
}

async function performRelayResume(
  queryClient: QueryClient,
  relay: Pick<PersistedRelay, "id" | "name">
): Promise<void> {
  const updatedRelay = await setRelayEnabled({
    data: { enabled: true, id: relay.id },
  })
  updateRelayCache(queryClient, [updatedRelay])
  await invalidateRelayRuntimeQueries(queryClient)
  dismissToast(relayPausedToastId(relay.id))
  dismissToast(relayResumeErrorToastId(relay.id))
  showToast({
    type: "success",
    message: <RelayToastTitle name={relay.name} state="resumed" />,
    id: relayResumedToastId(relay.id),
    icon: <Play className="size-4 text-emerald-400" />,
    description: "Hearth has resumed requesting Relay data.",
    duration: 4_000,
  })
}

function showPausedRelayToast(
  queryClient: QueryClient,
  relay: Pick<PersistedRelay, "id" | "name">
): void {
  showToast({
    type: "info",
    message: <RelayToastTitle name={relay.name} state="paused" />,
    id: relayPausedToastId(relay.id),
    icon: <Pause className="size-4 text-sky-400" />,
    description: "Hearth stopped requesting data. The Relay remains online.",
    duration: Infinity,
    action: {
      label: "Reconnect",
      onClick: (event) => {
        event.preventDefault()
        forkPromise(
          () => resumeRelay(queryClient, relay),
          (cause) =>
            showToast({
              type: "error",
              message: (
                <RelayToastTitle
                  name={relay.name}
                  state="could not be resumed"
                />
              ),
              id: relayResumeErrorToastId(relay.id),
              description: messageFrom(cause, "Try reconnecting again."),
              duration: 6_000,
            })
        )
      },
    },
  })
}

function showRelayError(cause: unknown, fallback: string) {
  showToast({
    type: "error",
    message: fallback,
    description: messageFrom(cause, fallback),
    duration: 6_000,
  })
}

function relayPausedToastId(relayId: string): string {
  return `relay-paused:${relayId}`
}

function relayResumedToastId(relayId: string): string {
  return `relay-resumed:${relayId}`
}

function relayResumeErrorToastId(relayId: string): string {
  return `relay-resume-error:${relayId}`
}

function messageFrom(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}
