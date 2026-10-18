import * as React from "react"
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Effect, Result } from "effect"
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  ExternalLink,
  Globe2,
  KeyRound,
  LoaderCircle,
  Pencil,
  Settings2,
  Trash2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  DataTableActionGroup,
  DataTableEmptyState,
  DataTableTextCell,
} from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { InfoCopyValue } from "@/components/info-page"
import { InfraSyncButton } from "@/components/infra-sync-button"
import { InstanceCard } from "@/components/instance-card"
import { statusColumnWidth } from "@/components/instance-name-presentation"
import { StatusIndicator } from "@/components/status-indicator"
import { WorkspaceCopyValueButton } from "@/components/workspace-header"
import { WorkspaceSummaryCard } from "@/components/workspace-summary-card"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import {
  replaceDataTableUrlSearch,
  type DataTableSearchStore,
} from "@/lib/data-table-search"
import type { DataTableSource } from "@/lib/data-table-source"
import {
  defaultDomainBlacklistPatterns,
  domainNameSchema,
  validateBlacklistPatterns,
  vanityLabelSchema,
} from "@/lib/domain-schemas"
import { domainSettingsQueryOptions, queryKeys } from "@/lib/query-options"
import { ensuringPromise } from "@/effect/promise"
import {
  configureDomainIntegration,
  removeInstanceDomain,
  resyncDomainAssignments,
  setInstanceVanity,
  type ManagedDomainOverview,
} from "@/server/domains"

interface DomainIntegrationView {
  blacklistPatterns: Array<string>
  domain: string
  enabled: boolean
  zoneName: string
}

type DomainDialog =
  | { kind: "delete"; domain: ManagedDomainOverview }
  | { kind: "edit"; domain: ManagedDomainOverview }
  | null

const domainTableColumnHelper =
  createDataTableColumnHelper<ManagedDomainOverview>()
const domainTableSearchFields = [
  (row: ManagedDomainOverview) => domainHostname(row),
  (row: ManagedDomainOverview) => row.address,
  (row: ManagedDomainOverview) => row.server.name,
  (row: ManagedDomainOverview) => row.server.game,
  (row: ManagedDomainOverview) => row.instanceId,
  (row: ManagedDomainOverview) => row.port,
  (row: ManagedDomainOverview) => row.relayName,
  (row: ManagedDomainOverview) => row.relayId,
  (row: ManagedDomainOverview) => row.status,
  (row: ManagedDomainOverview) => srvRecordLabel(row),
] as const

export const DomainsPage = React.memo(function DomainsPage({
  searchStore,
}: {
  searchStore: DataTableSearchStore
}) {
  const { data } = useSuspenseQuery(domainSettingsQueryOptions())
  const [configurationOpen, setConfigurationOpen] = React.useState(false)
  const [dialog, setDialog] = React.useState<DomainDialog>(null)
  const openConfiguration = React.useCallback(
    () => setConfigurationOpen(true),
    []
  )
  const closeDialog = React.useCallback((open: boolean) => {
    if (!open) setDialog(null)
  }, [])

  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col gap-3 px-3 pb-3 sm:px-5 sm:pb-5">
      <DomainSummaryCard
        integration={data.integration}
        onConfigure={openConfiguration}
      />

      <DataTableWorkspace
        toolbar={
          <DomainsToolbar
            syncEnabled={data.integration?.enabled === true}
            searchStore={searchStore}
          />
        }
      >
        <ManagedDomainsTable
          domains={data.managedDomains}
          searchStore={searchStore}
          zoneName={data.integration?.zoneName}
          onDialog={setDialog}
        />
      </DataTableWorkspace>

      {configurationOpen ? (
        <DomainConfigurationDialog
          key={domainIntegrationKey(data.integration)}
          hearthDomain={data.hearthDomain}
          integration={data.integration}
          open
          onOpenChange={setConfigurationOpen}
        />
      ) : null}
      {dialog?.kind === "edit" ? (
        <EditDomainDialog
          key={managedDomainRowKey(dialog.domain)}
          domain={dialog.domain}
          onOpenChange={closeDialog}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteDomainDialog
          key={managedDomainRowKey(dialog.domain)}
          domain={dialog.domain}
          onOpenChange={closeDialog}
        />
      ) : null}
    </div>
  )
})

const DomainSummaryCard = React.memo(function DomainSummaryCard({
  integration,
  onConfigure,
}: {
  integration: DomainIntegrationView | null
  onConfigure: () => void
}) {
  const active = integration?.enabled === true
  const configured = integration !== null

  return (
    <WorkspaceSummaryCard
      action={
        <Button
          className="shrink-0"
          size="sm"
          type="button"
          variant="outline"
          onClick={onConfigure}
        >
          <Settings2 />
          Configure Vanity
        </Button>
      }
      icon={<Globe2 className="size-5" />}
      iconClassName={
        active
          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
          : configured
            ? "border-amber-300/25 bg-amber-300/8 text-amber-200"
            : "border-border/80 bg-background/70 text-muted-foreground"
      }
      title="Vanity URL"
      titleAccessory={<DomainStatus enabled={active} verified={configured} />}
    >
      <p className="type-code mt-1 truncate text-muted-foreground">
        {`<vanity>.${integration?.domain ?? "example.com"}`}
      </p>
    </WorkspaceSummaryCard>
  )
})

const DomainsToolbar = React.memo(function DomainsToolbar({
  searchStore,
  syncEnabled,
}: {
  searchStore: DataTableSearchStore
  syncEnabled: boolean
}) {
  return (
    <DataTableToolbar
      leading={<DomainSyncButton enabled={syncEnabled} />}
      search={{
        ariaLabel: "Search domains",
        closeMobileWhenEmpty: true,
        id: "domain-search",
        onValueChange: replaceDataTableUrlSearch,
        placeholder: "Search domains",
        store: searchStore,
      }}
    />
  )
})

const DomainSyncButton = React.memo(function DomainSyncButton({
  enabled,
}: {
  enabled: boolean
}) {
  const queryClient = useQueryClient()
  const sync = React.useCallback(async () => {
    const result = await ensuringPromise(
      () => resyncDomainAssignments(),
      () => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.domains.settings,
        })
        void queryClient.invalidateQueries({
          queryKey: queryKeys.relay.snapshot,
        })
      }
    )
    showToast({
      message: `Synced ${result.syncedServerCount} ${
        result.syncedServerCount === 1
          ? "game server address"
          : "game server addresses"
      }`,
      type: "success",
    })
  }, [queryClient])

  return (
    <InfraSyncButton
      disabled={!enabled}
      label="Sync managed domains"
      sync={sync}
      onError={showErrorToast}
    />
  )
})

const ManagedDomainsTable = React.memo(function ManagedDomainsTable({
  domains,
  onDialog,
  searchStore,
  zoneName,
}: {
  domains: Array<ManagedDomainOverview>
  onDialog: (dialog: DomainDialog) => void
  searchStore: DataTableSearchStore
  zoneName: string | undefined
}) {
  // The server sorts by domain, so a rename or delete shifts later rows.
  // Match rows by game server instead of position, so only changed rows
  // repaint.
  const [rowCache] = React.useState(
    () => new Map<string, { json: string; row: ManagedDomainOverview }>()
  )
  const source = React.useMemo<DataTableSource<ManagedDomainOverview>>(() => {
    const seen = new Set<string>()
    const rows = domains.map((domain) => {
      const key = managedDomainRowKey(domain)
      const json = JSON.stringify(domain)
      seen.add(key)
      const cached = rowCache.get(key)
      if (cached?.json === json) return cached.row
      rowCache.set(key, { json, row: domain })
      return domain
    })
    for (const key of rowCache.keys()) {
      if (!seen.has(key)) rowCache.delete(key)
    }
    return { body: { kind: "ready" }, refreshing: false, rows }
  }, [domains, rowCache])
  const [initialTableState] = React.useState(() => ({
    sorting: [{ desc: false, id: "domain" }],
  }))
  const definition = React.useMemo(() => {
    const columns = domainTableColumnHelper.columns([
      domainTableColumnHelper.accessor((domain) => domain.status, {
        id: "status",
        header: () => <span className="sr-only sm:not-sr-only">Status</span>,
        sortFn: "text",
        cell: ({ row }) => (
          <StatusIndicator status={domainStatusPresentation(row.original)} />
        ),
        meta: dataTableColumnMeta(
          { width: { base: "2.5rem", sm: statusColumnWidth } },
          {
            cellClassName: "px-2 sm:px-3",
            headerClassName: "px-2 sm:px-3",
            headerLabelClassName: "shrink-0 overflow-visible text-clip",
          }
        ),
      }),
      domainTableColumnHelper.accessor((domain) => domain.server.name, {
        id: "server",
        header: "Game Server",
        sortFn: "text",
        cell: ({ row }) => <DomainServerCell domain={row.original} />,
        meta: dataTableColumnMeta(
          {
            // Phones keep the domain, which this table is about.
            hideBelow: "sm",
            width: { base: "minmax(0,1fr)", md: "minmax(0,1.1fr)" },
          },
          { cellClassName: "px-0" }
        ),
      }),
      domainTableColumnHelper.accessor((domain) => domainHostname(domain), {
        id: "domain",
        header: "Domain",
        sortFn: "text",
        cell: ({ row }) => (
          <div className="type-meta flex w-full min-w-0">
            <WorkspaceCopyValueButton
              label="domain"
              value={domainHostname(row.original)}
            />
          </div>
        ),
        meta: dataTableColumnMeta({
          width: { base: "minmax(0,1fr)", md: "minmax(0,1.2fr)" },
        }),
      }),
      domainTableColumnHelper.accessor((domain) => domain.port, {
        id: "port",
        header: "Port",
        sortFn: (left, right) => left.original.port - right.original.port,
        cell: ({ row }) => (
          <InfoCopyValue label="port" value={String(row.original.port)} />
        ),
        meta: dataTableColumnMeta({ hideBelow: "sm", width: "6.5rem" }),
      }),
      domainTableColumnHelper.accessor((domain) => srvRecordLabel(domain), {
        id: "srv",
        header: "SRV",
        sortFn: "text",
        cell: ({ row }) => <SrvRecordCell domain={row.original} />,
        meta: dataTableColumnMeta({ hideBelow: "md", width: "7.5rem" }),
      }),
      domainTableColumnHelper.accessor((domain) => domain.relayName, {
        id: "relay",
        header: "Relay",
        sortFn: "text",
        cell: ({ row }) => <DataTableTextCell value={row.original.relayName} />,
        meta: dataTableColumnMeta({
          hideBelow: "lg",
          width: "minmax(0,0.7fr)",
        }),
      }),
      domainTableColumnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <DomainActions
            domain={row.original}
            zoneName={zoneName}
            onDialog={onDialog}
          />
        ),
        meta: dataTableColumnMeta(
          { width: "7rem" },
          { cellClassName: "px-1 sm:px-3", headerClassName: "px-1 sm:px-3" }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Managed domains",
      columns,
      getRowId: managedDomainRowKey,
      model: { initialState: initialTableState },
      search: { fields: domainTableSearchFields },
      virtualization: true,
    })
  }, [initialTableState, onDialog, zoneName])

  return (
    <DataTable
      definition={definition}
      emptyState={renderEmptyDomains}
      searchStore={searchStore}
      source={source}
    />
  )
})

const DomainServerCell = React.memo(function DomainServerCell({
  domain,
}: {
  domain: ManagedDomainOverview
}) {
  const { server } = domain
  return (
    <Link
      to="/server/$serverId/console"
      params={{ serverId: server.routeId }}
      preload="intent"
      className="group/server-link flex min-h-14 w-full min-w-0 items-center px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
    >
      <InstanceCard
        className="min-w-0 flex-1"
        instance={{
          brickId: server.brickId,
          id: domain.instanceId,
          implementation: server.implementation,
          kind: "server",
          relayId: domain.relayId,
        }}
        meta={
          [server.game, server.implementation].filter(Boolean).join(" · ") ||
          domain.instanceId.slice(0, 8)
        }
        metaClassName="font-mono"
        name={server.name}
        nameClassName="transition-colors group-hover/server-link:text-primary"
        showFavorite={false}
        showStatus={false}
      />
    </Link>
  )
})

function SrvRecordCell({ domain }: { domain: ManagedDomainOverview }) {
  return domain.srvActive ? (
    <span className="type-meta inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
      <Check aria-hidden className="size-3" />
      Active
    </span>
  ) : (
    <span className="type-meta text-muted-foreground">
      {srvRecordLabel(domain)}
    </span>
  )
}

const DomainActions = React.memo(function DomainActions({
  domain,
  onDialog,
  zoneName,
}: {
  domain: ManagedDomainOverview
  onDialog: (dialog: DomainDialog) => void
  zoneName: string | undefined
}) {
  const hostname = domainHostname(domain)

  return (
    <DataTableActionGroup>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={`Edit ${hostname}`}
            className="text-muted-foreground hover:text-primary"
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={() => onDialog({ kind: "edit", domain })}
          >
            <Pencil />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Edit</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={`Delete ${hostname}`}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={() => onDialog({ kind: "delete", domain })}
          >
            <Trash2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Delete</TooltipContent>
      </Tooltip>
      {zoneName ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              className="text-muted-foreground hover:text-primary"
              size="icon-sm"
              variant="ghost"
            >
              <a
                aria-label={`View ${hostname} on Cloudflare`}
                href={cloudflareDnsRecordsUrl(zoneName)}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">View on Cloudflare</TooltipContent>
        </Tooltip>
      ) : null}
    </DataTableActionGroup>
  )
})

function renderEmptyDomains({ searchActive }: { searchActive: boolean }) {
  return (
    <DataTableEmptyState
      description={
        <span className="block max-w-sm">
          {searchActive
            ? "Try a vanity address, game server, Relay, port, status, or ID."
            : "Active vanity addresses will appear here after a game server is provisioned."}
        </span>
      }
      icon={<Globe2 className="size-6 text-muted-foreground/45" />}
      title={
        searchActive ? "No domains match your search" : "No Active Domains"
      }
    />
  )
}

function EditDomainDialog({
  domain,
  onOpenChange,
}: {
  domain: ManagedDomainOverview
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [vanityLabel, setVanityLabel] = React.useState(domain.vanityLabel)
  const parsed = vanityLabelSchema.safeParse(vanityLabel)
  const unchanged = parsed.success && parsed.data === domain.vanityLabel
  const save = useMutation({
    mutationFn: (label: string) =>
      setInstanceVanity({
        data: {
          instanceId: domain.instanceId,
          relayId: domain.relayId,
          vanityLabel: label,
        },
      }),
    // A failed rename can still clear a failed domain's leftover records.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.domains.settings,
      }),
    onSuccess: (result) => {
      showToast({ message: `Renamed to ${result.address}`, type: "success" })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open onOpenChange={save.isPending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit domain</DialogTitle>
          <DialogDescription>
            Choose the vanity name players use to join {domain.server.name}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (parsed.success && !unchanged) save.mutate(parsed.data)
          }}
        >
          <label className="type-label block space-y-1.5">
            Vanity name
            <div className="flex min-w-0 items-center gap-2">
              <Input
                autoCapitalize="none"
                autoCorrect="off"
                autoFocus
                aria-invalid={!parsed.success || undefined}
                className="min-w-0 flex-1 font-mono"
                maxLength={63}
                name="vanityLabel"
                spellCheck={false}
                value={vanityLabel}
                onChange={(event) => setVanityLabel(event.currentTarget.value)}
              />
              <span className="type-code shrink-0 text-muted-foreground">
                .{domain.domain}
              </span>
            </div>
            <span
              className={
                parsed.success
                  ? "type-meta block text-muted-foreground"
                  : "type-meta block text-destructive"
              }
            >
              {parsed.success
                ? "Kiln updates the DNS records in Cloudflare."
                : (parsed.error.issues[0]?.message ?? "Enter a vanity name")}
            </span>
          </label>

          {save.error ? <ConfigurationError error={save.error} /> : null}

          <DialogFooter>
            <Button
              disabled={save.isPending}
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={save.isPending || !parsed.success || unchanged}
              type="submit"
            >
              {save.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Check />
              )}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDomainDialog({
  domain,
  onOpenChange,
}: {
  domain: ManagedDomainOverview
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const hostname = domainHostname(domain)
  const remove = useMutation({
    mutationFn: () =>
      removeInstanceDomain({
        data: { instanceId: domain.instanceId, relayId: domain.relayId },
      }),
    // A failed delete marks the domain as failed, so refresh either way.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.domains.settings,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.relay.snapshot }),
      ]),
    onSuccess: () => {
      showToast({ message: `Deleted ${hostname}`, type: "success" })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open onOpenChange={remove.isPending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete domain</DialogTitle>
          <DialogDescription>
            Kiln deletes <span className="font-mono">{hostname}</span> from
            Cloudflare. Players join {domain.server.name} by its Relay address
            instead, and Kiln won&apos;t give it a new vanity domain when it
            starts or syncs.
          </DialogDescription>
        </DialogHeader>

        {remove.error ? <ConfigurationError error={remove.error} /> : null}

        <DialogFooter>
          <Button
            disabled={remove.isPending}
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={remove.isPending}
            type="button"
            variant="destructive"
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Trash2 />
            )}
            Delete domain
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DomainConfigurationDialog({
  hearthDomain,
  integration,
  open,
  onOpenChange,
}: {
  hearthDomain: string
  integration: DomainIntegrationView | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [mode, setMode] = React.useState<"settings" | "permissions">("settings")
  const [domain, setDomain] = React.useState(integration?.domain ?? "")
  const [permissionsDomain, setPermissionsDomain] = React.useState(hearthDomain)
  const [permissionsPending, setPermissionsPending] = React.useState(false)
  const [enabled, setEnabled] = React.useState(integration?.enabled ?? true)
  const [blacklistPatterns, setBlacklistPatterns] = React.useState(() =>
    (
      integration?.blacklistPatterns ?? [...defaultDomainBlacklistPatterns]
    ).join("\n")
  )
  const [apiToken, setApiToken] = React.useState("")
  const configure = useMutation({
    mutationFn: configureDomainIntegration,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.domains.settings,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.relay.snapshot }),
      ])
      showToast({
        message: "Cloudflare vanity configuration saved",
        type: "success",
      })
      onOpenChange(false)
    },
  })

  const save = React.useCallback(() => {
    const parsedDomain = domainNameSchema.safeParse(domain)
    if (!parsedDomain.success) {
      showToast({
        message:
          parsedDomain.error.issues[0]?.message ?? "Enter a valid domain",
        type: "error",
      })
      return
    }
    const patternsResult = Result.try(() =>
      validateBlacklistPatterns(
        blacklistPatterns
          .split(/\r?\n/u)
          .map((pattern) => pattern.trim())
          .filter(Boolean)
      )
    )
    if (Result.isFailure(patternsResult)) {
      showToast({
        message: errorMessage(patternsResult.failure),
        type: "error",
      })
      return
    }
    const token = apiToken.trim()
    if ((!integration && !token) || (token && token.length < 20)) {
      showToast({
        message: "Enter a valid Cloudflare API token",
        type: "error",
      })
      return
    }
    configure.mutate({
      data: {
        apiToken: token || undefined,
        blacklistPatterns: patternsResult.success,
        domain: parsedDomain.data,
        enabled,
      },
    })
  }, [apiToken, blacklistPatterns, configure, domain, enabled, integration])
  const openPermissions = React.useCallback(async () => {
    setPermissionsPending(true)
    await Effect.runPromise(
      Effect.tryPromise({
        try: () => import("@/lib/domain-name"),
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: () => {
            showToast({
              message: "Could not load the Cloudflare permissions preview",
              type: "error",
            })
          },
          onSuccess: ({ rootDomainForHostname }) => {
            setPermissionsDomain(rootDomainForHostname(domain) || hearthDomain)
            setMode("permissions")
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            setPermissionsPending(false)
          })
        )
      )
    )
  }, [domain, hearthDomain])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={mode === "permissions" ? "sm:max-w-3xl" : "sm:max-w-xl"}
      >
        <DialogHeader>
          {mode === "settings" ? (
            <>
              <DialogTitle>Configure vanity URLs</DialogTitle>
              <DialogDescription>
                Choose the suffix Kiln uses for managed game-server addresses.
              </DialogDescription>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <Button
                className="-ml-2"
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setMode("settings")}
              >
                <ArrowLeft /> Back
              </Button>
              <DialogTitle>Required Cloudflare permissions</DialogTitle>
              <DialogDescription className="sr-only">
                Cloudflare permissions required by Kiln.
              </DialogDescription>
            </div>
          )}
        </DialogHeader>

        {mode === "settings" ? (
          <VanitySettingsForm
            apiToken={apiToken}
            blacklistPatterns={blacklistPatterns}
            domain={domain}
            enabled={enabled}
            error={configure.error}
            hasIntegration={Boolean(integration)}
            isPending={configure.isPending}
            permissionsPending={permissionsPending}
            onApiTokenChange={setApiToken}
            onBlacklistPatternsChange={setBlacklistPatterns}
            onCancel={() => onOpenChange(false)}
            onDomainChange={setDomain}
            onEnabledChange={setEnabled}
            onOpenPermissions={openPermissions}
            onSave={save}
          />
        ) : (
          <CloudflarePermissionsPreview
            domain={permissionsDomain}
            error={configure.error}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function VanitySettingsForm({
  apiToken,
  blacklistPatterns,
  domain,
  enabled,
  error,
  hasIntegration,
  isPending,
  permissionsPending,
  onApiTokenChange,
  onBlacklistPatternsChange,
  onCancel,
  onDomainChange,
  onEnabledChange,
  onOpenPermissions,
  onSave,
}: {
  apiToken: string
  blacklistPatterns: string
  domain: string
  enabled: boolean
  error: Error | null
  hasIntegration: boolean
  isPending: boolean
  permissionsPending: boolean
  onApiTokenChange: (value: string) => void
  onBlacklistPatternsChange: (value: string) => void
  onCancel: () => void
  onDomainChange: (value: string) => void
  onEnabledChange: (enabled: boolean) => void
  onOpenPermissions: () => void
  onSave: () => void
}) {
  const tokenLength = apiToken.trim().length
  const tokenInvalid = tokenLength < 20 && (!hasIntegration || tokenLength > 0)

  return (
    <div className="space-y-4">
      <label className="type-label block space-y-1.5">
        Vanity domain
        <Input
          autoCapitalize="none"
          autoCorrect="off"
          className="font-mono"
          name="domain"
          placeholder="example.gg"
          required
          value={domain}
          onChange={(event) => onDomainChange(event.currentTarget.value)}
        />
        <span className="type-meta block font-mono text-muted-foreground">
          {`<vanity>.${domain.trim() || "example.gg"}`}
        </span>
      </label>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <label className="type-control-sm" htmlFor="cloudflare-api-token">
            Cloudflare API token
          </label>
          <a
            className="type-label inline-flex items-center gap-1 text-primary hover:underline"
            href="https://dash.cloudflare.com/profile/api-tokens"
            rel="noreferrer"
            target="_blank"
          >
            Create token <ExternalLink className="size-2.5" />
          </a>
        </div>
        <div className="flex items-center gap-2">
          <Input
            autoComplete="new-password"
            className="min-w-0 flex-1 font-mono"
            id="cloudflare-api-token"
            minLength={20}
            name="apiToken"
            placeholder="Cloudflare Token"
            required={!hasIntegration}
            type="password"
            value={apiToken}
            onChange={(event) => onApiTokenChange(event.currentTarget.value)}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Preview required Cloudflare permissions"
                aria-busy={permissionsPending}
                disabled={permissionsPending}
                size="icon"
                type="button"
                variant="outline"
                onClick={onOpenPermissions}
              >
                {permissionsPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <CircleHelp />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">
              Preview required permissions
            </TooltipContent>
          </Tooltip>
        </div>
        <p className="type-meta flex items-start gap-1.5 text-muted-foreground">
          <KeyRound className="mt-0.5 size-3 shrink-0" />
          <span>
            {hasIntegration
              ? "Optional. Leave blank to keep the encrypted token already on file."
              : "Stored encrypted and restricted to the DNS zone Kiln manages."}
          </span>
        </p>
      </div>

      <div className="flex items-center justify-between gap-4 border border-border/75 bg-background/35 p-3">
        <div>
          <p className="text-xs font-medium">Automatic provisioning</p>
          <p className="type-meta mt-0.5 text-muted-foreground">
            Create and reconcile DNS records as servers are provisioned.
          </p>
        </div>
        <Switch
          aria-label="Enable automatic domain provisioning"
          checked={enabled}
          onCheckedChange={onEnabledChange}
        />
      </div>

      <label className="type-label block space-y-1.5">
        Blacklisted vanity names
        <Textarea
          aria-label="Blacklisted vanity name patterns"
          className="min-h-36 font-mono text-xs"
          placeholder={"^(admin|api|www)$\n^staff-"}
          value={blacklistPatterns}
          onChange={(event) =>
            onBlacklistPatternsChange(event.currentTarget.value)
          }
        />
        <span className="type-meta block text-muted-foreground">
          One case-insensitive regular expression per line.
        </span>
      </label>

      {error ? <ConfigurationError error={error} /> : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={isPending || tokenInvalid}
          type="button"
          onClick={onSave}
        >
          {isPending ? <LoaderCircle className="animate-spin" /> : <Check />}
          {tokenLength ? "Verify & save" : "Save configuration"}
        </Button>
      </DialogFooter>
    </div>
  )
}

function CloudflarePermissionsPreview({
  domain,
  error,
}: {
  domain: string
  error: Error | null
}) {
  return (
    <div className="space-y-4">
      <CloudflarePermissionPolicy domain={domain} />

      <div className="flex gap-2 border border-amber-500/25 bg-amber-400/8 p-3 text-amber-950/85 dark:border-amber-400/20 dark:bg-amber-400/5 dark:text-amber-100/85">
        <KeyRound className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
        <p className="type-meta">
          Kiln encrypts the token at rest, never returns it to the browser, and
          keeps every managed record DNS-only.
        </p>
      </div>

      {error ? <ConfigurationError error={error} /> : null}
    </div>
  )
}

function CloudflarePermissionPolicy({ domain }: { domain: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-black/15 bg-[#fafafa] text-[#191919] shadow-lg shadow-black/10 dark:border-white/12 dark:bg-[#101010] dark:text-[#ededed] dark:shadow-black/15">
      <div className="flex items-center justify-between border-b border-black/10 bg-[#f1f1f1] px-3 py-2.5 dark:border-white/10 dark:bg-[#141414]">
        <p className="type-label">Edit policy</p>
        <span className="type-meta text-stone-600 dark:text-stone-300">
          Custom
        </span>
      </div>

      <div className="grid gap-2 border-b border-black/10 p-3 sm:grid-cols-[minmax(9rem,0.8fr)_minmax(0,1.35fr)] dark:border-white/10">
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-black/15 bg-white px-3 py-2.5 dark:border-white/15 dark:bg-white/[0.025]">
          <span className="type-label">Specified domains</span>
          <ChevronDown className="size-3.5 shrink-0 text-black/45 dark:text-white/45" />
        </div>
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-black/20 bg-white px-3 py-2.5 dark:border-white/20 dark:bg-white/[0.045]">
          <Globe2 className="size-3.5 shrink-0 text-black/70 dark:text-white/70" />
          <span className="type-code truncate text-stone-900 dark:text-stone-100">
            {domain}
          </span>
          <ChevronDown className="ml-auto size-3.5 shrink-0 text-black/45 dark:text-white/45" />
        </div>
      </div>

      <VisualPermissionGroup label="Developer Platform" total={4} />
      <VisualPermissionGroup label="AI & Machine Learning" total={4} />
      <VisualPermissionGroup label="DNS & Zones" selected={2} total={12}>
        <CloudflarePermissionRow
          description="Grants write access to DNS"
          edit
          name="DNS"
        />
        <CloudflarePermissionRow
          description="Grants read access to zone management"
          name="Zone"
          read
        />
        <CloudflarePermissionRow
          description="Grants read access to zone custom assets"
          name="Zone Custom Asset"
        />
        <CloudflarePermissionRow
          description="Grants access to Zone DNS Settings"
          name="Zone DNS Settings"
        />
        <CloudflarePermissionRow
          description="Grants access to zone settings"
          name="Zone Settings"
        />
      </VisualPermissionGroup>
      <VisualPermissionGroup label="App Security" total={25} />
    </div>
  )
}

function VisualPermissionGroup({
  children,
  label,
  selected = 0,
  total,
}: {
  children?: React.ReactNode
  label: string
  selected?: number
  total: number
}) {
  const expanded = children !== undefined

  return (
    <div className="border-b border-black/10 last:border-b-0 dark:border-white/10">
      <div className="flex items-center gap-2 bg-black/[0.015] px-3 py-2.5 dark:bg-white/[0.015]">
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-black/75 dark:text-white/75" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-black/30 dark:text-white/30" />
        )}
        <span
          className={
            expanded
              ? "type-label text-stone-900 dark:text-stone-100"
              : "type-label text-stone-600 dark:text-stone-300"
          }
        >
          {label}
        </span>
        <span className="type-meta ml-auto font-mono text-stone-600 dark:text-stone-300">
          {selected}/{total}
        </span>
      </div>
      {children}
    </div>
  )
}

function CloudflarePermissionRow({
  description,
  edit = false,
  name,
  read = false,
}: {
  description: string
  edit?: boolean
  name: string
  read?: boolean
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-t border-dashed border-black/10 px-3 py-2.5 sm:grid-cols-[minmax(8rem,0.8fr)_minmax(10rem,1.25fr)_auto] sm:items-center dark:border-white/10">
      <p className="type-label col-start-1 row-start-1 truncate text-stone-900 dark:text-stone-100">
        {name}
      </p>
      <p className="type-meta col-start-1 row-start-2 mt-0.5 truncate text-stone-600 sm:col-start-2 sm:row-start-1 sm:mt-0 dark:text-stone-300">
        {description}
      </p>
      <div className="col-start-2 row-span-2 row-start-1 flex items-center rounded-md border border-black/12 bg-black/[0.035] p-1 sm:col-start-3 sm:row-span-1 dark:border-white/12 dark:bg-black/25">
        <PermissionAccess active={read} label="Read" />
        <PermissionAccess active={edit} label="Edit" />
      </div>
    </div>
  )
}

function PermissionAccess({
  active,
  label,
}: {
  active: boolean
  label: string
}) {
  return (
    <span
      className={
        active
          ? "type-label flex items-center gap-1.5 rounded px-1.5 py-1 text-stone-900 dark:text-stone-100"
          : "type-meta flex items-center gap-1.5 rounded px-1.5 py-1 text-stone-600 dark:text-stone-300"
      }
    >
      <span
        className={
          active
            ? "grid size-3.5 place-items-center rounded-[3px] border border-black bg-black text-white dark:border-white dark:bg-white dark:text-black"
            : "size-3.5 rounded-[3px] border border-black/20 bg-black/[0.025] dark:border-white/15 dark:bg-black/20"
        }
      >
        {active ? <Check className="size-2.5" strokeWidth={3} /> : null}
      </span>
      {label}
      <span className="sr-only">{active ? "selected" : "not selected"}</span>
    </span>
  )
}

function ConfigurationError({ error }: { error: Error }) {
  return (
    <p className="border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      {errorMessage(error)}
    </p>
  )
}

function DomainStatus({
  enabled,
  verified,
}: {
  enabled: boolean
  verified: boolean
}) {
  const active = verified && enabled
  return (
    <span
      className={
        active
          ? "type-technical-label inline-flex items-center gap-1 text-emerald-300"
          : "type-technical-label inline-flex items-center gap-1 text-muted-foreground"
      }
    >
      {verified ? (
        <span
          className={
            active
              ? "size-1.5 rounded-full bg-emerald-400"
              : "size-1.5 rounded-full bg-muted-foreground"
          }
        />
      ) : (
        <CircleAlert className="size-2.5" />
      )}
      {active ? "Active" : verified ? "Paused" : "Setup required"}
    </span>
  )
}

function managedDomainRowKey(domain: ManagedDomainOverview): string {
  return `${domain.relayId}:${domain.instanceId}`
}

function domainHostname(domain: ManagedDomainOverview): string {
  return `${domain.vanityLabel}.${domain.domain}`
}

function srvRecordLabel(domain: ManagedDomainOverview): string {
  return domain.srvActive
    ? "Active"
    : domain.supportsSrv
      ? "Not set"
      : "Unsupported"
}

function domainStatusPresentation(
  domain: ManagedDomainOverview
): IdentityStatusPresentation {
  if (domain.status === "active") return { label: "Active", tone: "success" }
  if (domain.status === "pending") {
    return { label: "Pending", pulse: true, tone: "warning" }
  }
  return {
    detail: domain.lastError ?? undefined,
    label: "Error",
    tone: "danger",
  }
}

// Cloudflare resolves `:account` to the signed-in account that owns the zone.
function cloudflareDnsRecordsUrl(zoneName: string): string {
  return `https://dash.cloudflare.com/?to=/:account/${encodeURIComponent(zoneName)}/dns/records`
}

function domainIntegrationKey(integration: DomainIntegrationView | null) {
  return integration
    ? `${integration.domain}:${integration.enabled}:${integration.blacklistPatterns.join("|")}`
    : "new"
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not save the domain"
}

function showErrorToast(cause: Error) {
  showToast({ message: errorMessage(cause), type: "error" })
}
