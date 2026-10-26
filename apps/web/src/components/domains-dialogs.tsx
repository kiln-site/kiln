// The Domains page's dialogs. They load after the page: when the browser
// is idle, or when one first opens.
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Effect, Fiber, Result } from "effect"
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  CircleHelp,
  ExternalLink,
  Globe2,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  domainHostname,
  errorMessage,
  serverKey,
  strategyOptions,
  type DirectoryServer,
  type DomainConnectionOverview,
  type VanityDomainChoice,
} from "@/components/domains-shared"
import { InstanceCard } from "@/components/instance-card"
import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import {
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import type { DomainAssignmentStrategy, VanitySettings } from "@/effect/domains"
import {
  defaultDomainBlacklistPatterns,
  domainInZone,
  domainNameSchema,
  validateBlacklistPatterns,
  vanityLabelSchema,
} from "@/lib/domain-schemas"
import { queryKeys, serverDirectoryQueryOptions } from "@/lib/query-options"
import {
  createInstanceDomain,
  deleteDomainConnection,
  discoverCloudflareDomains,
  releaseWebHostname,
  removeInstanceDomain,
  saveDomainConnection,
  saveVanitySettings,
  updateInstanceDomain,
  type DiscoveredCloudflareZone,
  type ManagedDomainOverview,
  type WebHostnameOverview,
} from "@/server/domains"

export function CreateDomainDialog({
  domains,
  initialServerKey,
  managedDomains,
  onOpenChange,
}: {
  domains: ReadonlyArray<VanityDomainChoice>
  /** The game server the table is filtered to. */
  initialServerKey: string | null
  managedDomains: Array<ManagedDomainOverview>
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const { data: servers = emptyServers } = useQuery(
    serverDirectoryQueryOptions()
  )
  const domainCounts = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const domain of managedDomains) {
      const key = serverKey(domain.relayId, domain.instanceId)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [managedDomains])
  const [selectedKey, setSelectedKey] = React.useState(initialServerKey)
  const [domain, setDomain] = React.useState(domains[0]?.domain ?? "")
  const [vanityLabel, setVanityLabel] = React.useState("")
  const [primary, setPrimary] = React.useState(false)
  const server = selectedKey
    ? servers.find((item) => serverKey(item.relayId, item.id) === selectedKey)
    : undefined
  const existingCount = selectedKey ? (domainCounts.get(selectedKey) ?? 0) : 0
  const label = vanityLabel.trim()
  const parsed = label ? vanityLabelSchema.safeParse(label) : null
  const create = useMutation({
    mutationFn: (target: DirectoryServer) =>
      createInstanceDomain({
        data: {
          domain,
          instanceId: target.id,
          primary,
          relayId: target.relayId,
          vanityLabel: parsed?.success ? parsed.data : undefined,
        },
      }),
    // A failed create can leave a failed row to retry or delete.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.domains.settings }),
    onSuccess: (result) => {
      showToast({ message: `Created ${result.address}`, type: "success" })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open onOpenChange={create.isPending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New domain</DialogTitle>
          <DialogDescription>
            Point a vanity address at a game server.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (server && parsed?.success !== false) create.mutate(server)
          }}
        >
          <div className="type-label space-y-1.5">
            <span id="new-domain-server">Game server</span>
            <GameServerPicker
              domainCounts={domainCounts}
              selectedKey={selectedKey}
              servers={servers}
              onSelect={setSelectedKey}
            />
          </div>

          <VanityNameField
            domain={domain}
            domains={domains}
            error={
              parsed && !parsed.success
                ? (parsed.error.issues[0]?.message ?? "Enter a vanity name")
                : null
            }
            hint="Leave blank and Kiln picks an available name."
            placeholder="generated"
            value={vanityLabel}
            onDomainChange={setDomain}
            onValueChange={setVanityLabel}
          />

          {server && existingCount > 0 ? (
            <PrimaryDomainSwitch
              checked={primary}
              serverName={server.name}
              onCheckedChange={setPrimary}
            />
          ) : server ? (
            <p className="type-meta text-muted-foreground">
              This becomes {server.name}&apos;s connect address.
            </p>
          ) : null}

          {create.error ? <ConfigurationError error={create.error} /> : null}

          <DialogFooter>
            <Button
              disabled={create.isPending}
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                create.isPending || !server || parsed?.success === false
              }
              type="submit"
            >
              {create.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Plus />
              )}
              Create domain
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const emptyServers: Array<DirectoryServer> = []

const GameServerPicker = React.memo(function GameServerPicker({
  domainCounts,
  onSelect,
  selectedKey,
  servers,
}: {
  domainCounts: ReadonlyMap<string, number>
  onSelect: (key: string) => void
  selectedKey: string | null
  servers: ReadonlyArray<DirectoryServer>
}) {
  const [open, setOpen] = React.useState(false)
  const items = React.useMemo(
    () =>
      servers.map((server): InstancePickerItem => {
        const key = serverKey(server.relayId, server.id)
        const count = domainCounts.get(key) ?? 0
        return {
          identity: {
            brickId: server.brickId,
            id: server.id,
            implementation: server.implementation,
            kind: "server",
            relayId: server.relayId,
          },
          key,
          meta: [
            server.relayName,
            server.shortId,
            count > 0 ? `${count} ${count === 1 ? "domain" : "domains"}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
          name: server.name,
          searchText: `${server.id} ${server.relayName} ${server.game}`,
        }
      }),
    [domainCounts, servers]
  )
  const selectedItem = selectedKey
    ? items.find((item) => item.key === selectedKey)
    : undefined
  const selectedKeys = React.useMemo(
    () => new Set(selectedKey ? [selectedKey] : []),
    [selectedKey]
  )
  const selectItem = React.useCallback(
    (item: InstancePickerItem) => {
      onSelect(item.key)
      setOpen(false)
    },
    [onSelect]
  )

  return (
    <DrawerPopover open={open} onOpenChange={setOpen}>
      <DrawerPopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-labelledby="new-domain-server"
          className="h-auto min-h-10 w-full justify-between gap-3 px-2 py-1.5 font-normal"
          role="combobox"
          type="button"
          variant="outline"
        >
          {selectedItem ? (
            <InstanceCard
              className="min-w-0 flex-1 gap-2 text-left"
              iconClassName="size-7 border-0 bg-muted/55"
              instance={selectedItem.identity}
              meta={selectedItem.meta}
              metaClassName="font-mono"
              name={selectedItem.name}
              nameClassName="type-control-sm"
              showFavorite={false}
              statusClassName="ring-background"
            />
          ) : (
            <span className="px-1 text-muted-foreground">
              Choose a game server
            </span>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DrawerPopoverTrigger>
      <DrawerPopoverContent
        title="Game servers"
        align="start"
        className="z-[70] w-(--radix-popover-trigger-width) min-w-72 overflow-hidden p-0"
      >
        <InstancePickerContent
          ariaLabel="Game servers"
          emptyMessage="No game servers"
          items={items}
          selectedKeys={selectedKeys}
          onSelect={selectItem}
        />
      </DrawerPopoverContent>
    </DrawerPopover>
  )
})

function VanityNameField({
  autoFocus = false,
  domain,
  domains,
  error,
  hint,
  onDomainChange,
  onValueChange,
  placeholder,
  value,
}: {
  autoFocus?: boolean
  domain: string
  domains: ReadonlyArray<VanityDomainChoice>
  error: string | null
  hint: string
  onDomainChange: (domain: string) => void
  onValueChange: (value: string) => void
  placeholder?: string
  value: string
}) {
  return (
    <div className="type-label space-y-1.5">
      <label htmlFor="vanity-label">Vanity name</label>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          autoCapitalize="none"
          autoCorrect="off"
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          className="min-w-0 flex-1 font-mono"
          id="vanity-label"
          maxLength={63}
          name="vanityLabel"
          placeholder={placeholder}
          spellCheck={false}
          value={value}
          onChange={(event) => onValueChange(event.currentTarget.value)}
        />
        {domains.length > 1 ? (
          <Select value={domain} onValueChange={onDomainChange}>
            <SelectTrigger
              aria-label="Domain"
              className="max-w-[60%] min-w-0 gap-0.5 font-mono text-xs [&_[data-slot=select-value]]:truncate"
            >
              <span className="text-muted-foreground">.</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[70]">
              {domains.map((item) => (
                <SelectItem
                  key={item.domain}
                  className="font-mono text-xs"
                  value={item.domain}
                >
                  {item.domain}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="type-code shrink-0 text-muted-foreground">
            .{domain}
          </span>
        )}
      </div>
      <span
        className={
          error
            ? "type-meta block text-destructive"
            : "type-meta block text-muted-foreground"
        }
      >
        {error ?? hint}
      </span>
    </div>
  )
}

function PrimaryDomainSwitch({
  checked,
  onCheckedChange,
  serverName,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  serverName: string
}) {
  return (
    <div className="flex items-center justify-between gap-4 border border-border/75 bg-background/35 p-3">
      <div>
        <p className="text-xs font-medium">Use as connect address</p>
        <p className="type-meta mt-0.5 text-muted-foreground">
          Show this domain on {serverName}&apos;s pages instead of its current
          one.
        </p>
      </div>
      <Switch
        aria-label="Use as connect address"
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}

export function EditDomainDialog({
  domain,
  domains,
  onOpenChange,
}: {
  domain: ManagedDomainOverview
  domains: ReadonlyArray<VanityDomainChoice>
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [vanityLabel, setVanityLabel] = React.useState(domain.vanityLabel)
  const [suffix, setSuffix] = React.useState(domain.domain)
  const [primary, setPrimary] = React.useState(domain.primary)
  const parsed = vanityLabelSchema.safeParse(vanityLabel)
  // Its current domain stays a choice even when it's disabled or no longer
  // configured, so it can be renamed in place.
  const choices = React.useMemo(
    () =>
      domains.some((item) => item.domain === domain.domain)
        ? domains
        : [...domains, { domain: domain.domain, platform: false }],
    [domain.domain, domains]
  )
  const unchanged =
    parsed.success &&
    parsed.data === domain.vanityLabel &&
    suffix === domain.domain &&
    primary === domain.primary
  const save = useMutation({
    mutationFn: (label: string) =>
      updateInstanceDomain({
        data: { domain: suffix, id: domain.id, primary, vanityLabel: label },
      }),
    // A failed rename can still clear a failed domain's leftover records.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.domains.settings,
      }),
    onSuccess: (result) => {
      showToast({ message: `Saved ${result.address}`, type: "success" })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open onOpenChange={save.isPending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit domain</DialogTitle>
          <DialogDescription>
            Choose the vanity address players use to join {domain.server.name}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (parsed.success && !unchanged) save.mutate(parsed.data)
          }}
        >
          <VanityNameField
            autoFocus
            domain={suffix}
            domains={choices}
            error={
              parsed.success
                ? null
                : (parsed.error.issues[0]?.message ?? "Enter a vanity name")
            }
            hint="Kiln updates the DNS records in Cloudflare."
            value={vanityLabel}
            onDomainChange={setSuffix}
            onValueChange={setVanityLabel}
          />

          {domain.primary ? (
            domain.domainCount > 1 ? (
              <p className="type-meta text-muted-foreground">
                This is {domain.server.name}&apos;s connect address. Make
                another of its domains primary to change it.
              </p>
            ) : null
          ) : (
            <PrimaryDomainSwitch
              checked={primary}
              serverName={domain.server.name}
              onCheckedChange={setPrimary}
            />
          )}

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

export function DeleteDomainDialog({
  domain,
  onOpenChange,
}: {
  domain: ManagedDomainOverview
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const hostname = domainHostname(domain)
  const remove = useMutation({
    mutationFn: () => removeInstanceDomain({ data: { id: domain.id } }),
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
            Cloudflare.{" "}
            {domain.domainCount > 1
              ? domain.primary
                ? `Another of ${domain.server.name}'s domains becomes its connect address.`
                : `${domain.server.name} keeps its other domains.`
              : `Players join ${domain.server.name} by its Relay address instead, and Kiln won't give it a new vanity domain when it starts or syncs.`}
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

/** A Cloudflare zone in the connection's list. */
interface DomainChoice {
  /** The suffix Kiln names addresses under: the zone itself. */
  domain: string
  /** A vanity domain, but the current token can't reach its zone. */
  missing: boolean
  /** A vanity domain: new game servers and apps get addresses under it. */
  selected: boolean
  zoneId: string
  zoneName: string
}

type TokenCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { count: number; status: "ready" }
  | { message: string; status: "error" }

/**
 * Connects a Cloudflare API token, or edits one. Kiln keeps the records of
 * web route hostnames in every zone it reaches; the zones marked vanity also
 * give new game servers and apps addresses.
 */
export function DomainConnectionDialog({
  canManagePlatform,
  connection,
  domainUsage,
  hearthDomain,
  onOpenChange,
}: {
  canManagePlatform: boolean
  /** Null to connect a new token. */
  connection: DomainConnectionOverview | null
  domainUsage: ReadonlyMap<string, number>
  hearthDomain: string
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const saved = connection !== null
  const [mode, setMode] = React.useState<"settings" | "permissions">("settings")
  const [name, setName] = React.useState(connection?.name ?? "Cloudflare")
  const [platform, setPlatform] = React.useState(connection?.platform ?? false)
  const [apiToken, setApiToken] = React.useState("")
  const [choices, setChoices] = React.useState<Array<DomainChoice>>(() => {
    const vanity = new Map(
      connection?.domains.map((domain) => [domain.zoneId, domain]) ?? []
    )
    return mergeDiscoveredZones(
      [...vanity.values()].map((domain) => ({
        domain: domain.domain,
        missing: false,
        selected: domain.enabled,
        zoneId: domain.zoneId,
        zoneName: domain.zoneName,
      })),
      connection?.zones ?? []
    )
  })
  const [defaultZoneId, setDefaultZoneId] = React.useState(
    () => connection?.domains.find((domain) => domain.isDefault)?.zoneId ?? ""
  )
  const [tokenCheck, setTokenCheck] = React.useState<TokenCheck>({
    status: "idle",
  })
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  // Bumped by the refresh button to list the zones again.
  const [scan, setScan] = React.useState(0)
  const handledScan = React.useRef(scan)

  // Lists the zones a pasted token, or the saved one, can manage. Typing
  // waits for a pause; a refresh checks at once. A newer check interrupts the
  // last one, aborting its request before a slow answer can overwrite it.
  React.useEffect(() => {
    const refreshed = scan !== handledScan.current
    handledScan.current = scan
    const token = apiToken.trim()
    // A saved connection's zones show until it's refreshed.
    if (token ? token.length < 20 : !saved || !refreshed) {
      setTokenCheck({ status: "idle" })
      return
    }
    const fiber = Effect.runFork(
      Effect.sleep(token && !refreshed ? 400 : 0).pipe(
        Effect.andThen(
          Effect.sync(() => setTokenCheck({ status: "checking" }))
        ),
        Effect.andThen(
          Effect.tryPromise({
            try: (signal) =>
              discoverCloudflareDomains({
                data: {
                  apiToken: token || undefined,
                  connectionId: token ? undefined : connection?.id,
                },
                signal,
              }),
            catch: (cause) => cause,
          })
        ),
        Effect.match({
          onFailure: (cause) =>
            setTokenCheck({ message: errorMessage(cause), status: "error" }),
          onSuccess: ({ zones }) => {
            setChoices((current) => mergeDiscoveredZones(current, zones))
            setTokenCheck({ count: zones.length, status: "ready" })
          },
        })
      )
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [apiToken, connection?.id, saved, scan])

  const selected = choices.filter((choice) => choice.selected)
  // The first chosen domain stands in until one is picked.
  const effectiveDefault =
    selected.find((choice) => choice.zoneId === defaultZoneId) ?? selected[0]
  const settle = async (message: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.domains.settings }),
      queryClient.invalidateQueries({ queryKey: queryKeys.relay.snapshot }),
    ])
    showToast({ message, type: "success" })
    onOpenChange(false)
  }
  const save = useMutation({
    mutationFn: saveDomainConnection,
    onSuccess: () =>
      settle(saved ? `Saved ${name.trim()}` : "Cloudflare connected"),
  })
  const remove = useMutation({
    mutationFn: () =>
      deleteDomainConnection({ data: { id: connection?.id ?? "" } }),
    onSuccess: () => settle(`Removed ${connection?.name ?? "connection"}`),
  })
  const pending = save.isPending || remove.isPending

  const updateChoice = React.useCallback(
    (zoneId: string, change: Partial<DomainChoice>) =>
      setChoices((current) =>
        current.map((choice) =>
          choice.zoneId === zoneId ? { ...choice, ...change } : choice
        )
      ),
    []
  )

  const submit = () => {
    const domains: Array<{ domain: string; zoneId: string }> = []
    for (const choice of selected) {
      const parsed = domainNameSchema.safeParse(choice.domain)
      if (!parsed.success || !domainInZone(parsed.data, choice.zoneName)) {
        showToast({
          message: `Use ${choice.zoneName} or a name ending in .${choice.zoneName}`,
          type: "error",
        })
        return
      }
      domains.push({ domain: parsed.data, zoneId: choice.zoneId })
    }
    const defaultDomain = effectiveDefault
      ? domains[selected.indexOf(effectiveDefault)]?.domain
      : undefined
    const token = apiToken.trim()
    save.mutate({
      data: {
        apiToken: token || undefined,
        defaultDomain,
        domains,
        id: connection?.id,
        name: name.trim(),
        platform,
      },
    })
  }

  const tokenLength = apiToken.trim().length
  const tokenInvalid = tokenLength < 20 && (!saved || tokenLength > 0)

  return (
    <Dialog open onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent
        className={mode === "permissions" ? "sm:max-w-3xl" : "sm:max-w-xl"}
      >
        <DialogHeader>
          {mode === "settings" ? (
            <>
              <DialogTitle>
                {saved ? `Edit ${connection.name}` : "Connect Cloudflare"}
              </DialogTitle>
              <DialogDescription>
                Kiln creates DNS records for web routes in every zone this
                token reaches. Zones marked vanity also give new game servers
                and apps addresses.
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
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
              <label className="type-control-sm block space-y-1.5">
                Name
                <Input
                  autoComplete="off"
                  maxLength={64}
                  name="name"
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </label>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <label
                    className="type-control-sm"
                    htmlFor="cloudflare-api-token"
                  >
                    API token
                  </label>
                  <a
                    className="type-label inline-flex items-center gap-1 text-primary-ink hover:underline"
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
                    autoFocus={!saved}
                    className="min-w-0 flex-1 font-mono"
                    id="cloudflare-api-token"
                    minLength={20}
                    name="apiToken"
                    placeholder={saved ? "Saved token" : "Paste a token"}
                    required={!saved}
                    type="password"
                    value={apiToken}
                    onChange={(event) => setApiToken(event.currentTarget.value)}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label="Preview required Cloudflare permissions"
                        size="icon"
                        type="button"
                        variant="outline"
                        onClick={() => setMode("permissions")}
                      >
                        <CircleHelp />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      Preview required permissions
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <p className="type-control-sm" id="connection-zones">
                  Zones
                </p>
                <div className="flex items-center gap-2">
                  {tokenCheck.status === "error" && choices.length > 0 ? (
                    <span className="type-meta flex min-w-0 items-center gap-1 text-destructive">
                      <CircleAlert className="size-3 shrink-0" />
                      <span className="truncate">{tokenCheck.message}</span>
                    </span>
                  ) : choices.length > 0 ? (
                    <span className="type-meta text-muted-foreground tabular-nums">
                      {selected.length} of {choices.length} vanity
                    </span>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label="Refresh zones from Cloudflare"
                        disabled={
                          tokenCheck.status === "checking" ||
                          (tokenLength === 0 ? !saved : tokenLength < 20)
                        }
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                        onClick={() => setScan((current) => current + 1)}
                      >
                        <RefreshCw
                          className={
                            tokenCheck.status === "checking"
                              ? "animate-spin"
                              : undefined
                          }
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      Refresh from Cloudflare
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <div className="max-h-60 overflow-y-auto rounded-md border border-border/75 bg-background/35">
                <table
                  aria-labelledby="connection-zones"
                  className="w-full table-fixed border-collapse"
                >
                  <thead className="sticky top-0 z-10 bg-[color-mix(in_oklab,var(--surface-overlay)_92%,transparent)] backdrop-blur">
                    <tr className="type-technical-label text-left text-muted-foreground">
                      <th className="w-16 px-3 py-2 font-normal">Vanity</th>
                      <th className="px-1 py-2 font-normal">Domain</th>
                      <th className="w-20 px-2 py-2 text-right font-normal">
                        In use
                      </th>
                      <th className="w-20 px-3 py-2 text-center font-normal">
                        Default
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60 border-t border-border/60">
                    {choices.length > 0 ? (
                      choices.map((choice) => (
                        <DomainZoneRow
                          key={choice.zoneId}
                          choice={choice}
                          isDefault={choice === effectiveDefault}
                          usage={domainUsage.get(choice.domain) ?? 0}
                          onChange={updateChoice}
                          onMakeDefault={setDefaultZoneId}
                        />
                      ))
                    ) : (
                      <tr>
                        <td
                          className="type-meta px-3 py-6 text-center text-muted-foreground"
                          colSpan={4}
                        >
                          {tokenCheck.status === "checking" ? (
                            "Listing the token's zones…"
                          ) : tokenCheck.status === "error" ? (
                            <span className="text-destructive">
                              {tokenCheck.message}
                            </span>
                          ) : (
                            "Paste a token to list the zones it can manage."
                          )}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {canManagePlatform && !saved ? (
              <div className="flex items-center justify-between gap-4 border border-border/75 bg-background/35 p-3">
                <div>
                  <p className="type-control-sm" id="platform-connection">
                    Kiln-provided
                  </p>
                  <p className="type-meta mt-0.5 text-muted-foreground">
                    Everyone&apos;s new game servers and apps get addresses
                    under its vanity domains, unless they add their own.
                  </p>
                </div>
                <Switch
                  aria-labelledby="platform-connection"
                  checked={platform}
                  onCheckedChange={setPlatform}
                />
              </div>
            ) : null}

            {save.error ? <ConfigurationError error={save.error} /> : null}
            {remove.error ? <ConfigurationError error={remove.error} /> : null}

            <DialogFooter className="sm:justify-between">
              {saved ? (
                <Button
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={pending}
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    confirmDelete ? remove.mutate() : setConfirmDelete(true)
                  }
                >
                  {remove.isPending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                  {confirmDelete ? "Remove and delete its records" : "Remove"}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button
                  disabled={pending}
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={pending || tokenInvalid || !name.trim()}
                  type="button"
                  onClick={submit}
                >
                  {save.isPending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Check />
                  )}
                  {tokenLength ? "Verify & save" : "Save"}
                </Button>
              </div>
            </DialogFooter>
          </div>
        ) : (
          <CloudflarePermissionsPreview
            domain={effectiveDefault?.zoneName ?? hearthDomain}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

const DomainZoneRow = React.memo(function DomainZoneRow({
  choice,
  isDefault,
  onChange,
  onMakeDefault,
  usage,
}: {
  choice: DomainChoice
  isDefault: boolean
  onChange: (zoneId: string, change: Partial<DomainChoice>) => void
  onMakeDefault: (zoneId: string) => void
  usage: number
}) {
  return (
    <tr className={choice.selected ? undefined : "text-muted-foreground"}>
      <td className="px-3 py-1.5 align-middle">
        <label className="flex cursor-pointer items-center">
          <input
            aria-label={`Use ${choice.zoneName} as a vanity domain`}
            checked={choice.selected}
            className="peer sr-only"
            type="checkbox"
            onChange={(event) =>
              onChange(choice.zoneId, { selected: event.currentTarget.checked })
            }
          />
          <span
            className={`grid size-4 place-items-center rounded-sm border peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40 ${
              choice.selected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-input"
            }`}
          >
            {choice.selected ? <Check className="size-3" /> : null}
          </span>
        </label>
      </td>
      <td className="px-1 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="type-code min-w-0 truncate">{choice.domain}</span>
          {!choice.selected && usage > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="type-meta shrink-0 text-muted-foreground">
                  Existing only
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                Its {usage} game server{" "}
                {usage === 1 ? "domain keeps" : "domains keep"} working. New
                game servers won&apos;t get it.
              </TooltipContent>
            </Tooltip>
          ) : null}
          <span className="flex-1" />
          {choice.missing ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <CircleAlert
                  aria-label="This token can't manage this zone"
                  className="size-3.5 shrink-0 text-amber-600 dark:text-amber-300"
                />
              </TooltipTrigger>
              <TooltipContent side="left">
                This token can&apos;t manage {choice.zoneName}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </td>
      <td className="type-meta px-2 py-1.5 text-right text-muted-foreground tabular-nums">
        {usage > 0 ? usage : "–"}
      </td>
      <td className="px-3 py-1.5 text-center">
        <label
          className={`inline-flex ${choice.selected ? "cursor-pointer" : "cursor-not-allowed opacity-40"}`}
        >
          <input
            aria-label={`Make ${choice.domain} the default`}
            checked={isDefault}
            className="peer sr-only"
            disabled={!choice.selected}
            name="default-domain"
            type="radio"
            onChange={() => onMakeDefault(choice.zoneId)}
          />
          <span
            className={`grid size-4 place-items-center rounded-full border peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40 ${
              isDefault ? "border-primary" : "border-input"
            }`}
          >
            {isDefault ? (
              <span className="size-2 rounded-full bg-primary" />
            ) : null}
          </span>
        </label>
      </td>
    </tr>
  )
})

/**
 * Keeps choices for zones still reachable, adds new zones unmarked, and flags
 * vanity zones the token lost.
 */
function mergeDiscoveredZones(
  current: ReadonlyArray<DomainChoice>,
  zones: ReadonlyArray<DiscoveredCloudflareZone>
): Array<DomainChoice> {
  const byZone = new Map(current.map((choice) => [choice.zoneId, choice]))
  const reachable = new Set(zones.map((zone) => zone.id))
  return [
    ...zones.map((zone): DomainChoice => {
      const existing = byZone.get(zone.id)
      return existing
        ? { ...existing, missing: false, zoneName: zone.name }
        : {
            domain: zone.name,
            missing: false,
            selected: false,
            zoneId: zone.id,
            zoneName: zone.name,
          }
    }),
    ...current
      .filter((choice) => choice.selected && !reachable.has(choice.zoneId))
      .map((choice) => ({ ...choice, missing: true })),
  ]
}

/**
 * Whether new game servers and apps get addresses under the person's vanity
 * domains, and how one is picked. Administrators also set Kiln's, which
 * everyone without vanity domains of their own gets.
 */
export function VanitySettingsDialog({
  onOpenChange,
  personalSettings,
  platformSettings,
}: {
  onOpenChange: (open: boolean) => void
  personalSettings: VanitySettings
  platformSettings: VanitySettings | null
}) {
  const queryClient = useQueryClient()
  const [personal, setPersonal] = React.useState(personalSettings)
  const [platform, setPlatform] = React.useState(platformSettings)
  const [blacklistPatterns, setBlacklistPatterns] = React.useState(() =>
    (platformSettings && platformSettings.blacklistPatterns.length > 0
      ? platformSettings.blacklistPatterns
      : [...defaultDomainBlacklistPatterns]
    ).join("\n")
  )
  const save = useMutation({
    mutationFn: async () => {
      await saveVanitySettings({
        data: { ...personal, blacklistPatterns: [], platform: false },
      })
      if (!platform) return
      const patterns = Result.try(() =>
        validateBlacklistPatterns(
          blacklistPatterns
            .split(/\r?\n/u)
            .map((pattern) => pattern.trim())
            .filter(Boolean)
        )
      )
      if (Result.isFailure(patterns)) throw patterns.failure
      await saveVanitySettings({
        data: {
          ...platform,
          blacklistPatterns: patterns.success,
          platform: true,
        },
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.domains.settings,
      })
      showToast({ message: "Vanity settings saved", type: "success" })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open onOpenChange={save.isPending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Vanity addresses</DialogTitle>
          <DialogDescription>
            New game servers and apps get an address under a vanity domain:
            yours when you have any, otherwise Kiln&apos;s.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <AutomaticAddresses
            description="Under the vanity domains on your connections."
            id="personal-addresses"
            settings={personal}
            title="Your domains"
            onChange={setPersonal}
          />
          {platform ? (
            <>
              <AutomaticAddresses
                description="Under Kiln-provided vanity domains, for everyone without their own."
                id="platform-addresses"
                settings={platform}
                title="Kiln-provided domains"
                onChange={setPlatform}
              />
              <label className="type-label block space-y-1.5">
                Reserved names on Kiln-provided domains
                <Textarea
                  aria-label="Reserved vanity name patterns"
                  className="min-h-24 font-mono text-xs"
                  placeholder={"^(admin|api|www)$\n^staff-"}
                  value={blacklistPatterns}
                  onChange={(event) =>
                    setBlacklistPatterns(event.currentTarget.value)
                  }
                />
                <span className="type-meta block text-muted-foreground">
                  One case-insensitive regular expression per line.
                </span>
              </label>
            </>
          ) : null}

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
              disabled={save.isPending}
              type="button"
              onClick={() => save.mutate()}
            >
              {save.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Check />
              )}
              Save
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function AutomaticAddresses({
  description,
  id,
  onChange,
  settings,
  title,
}: {
  description: string
  id: string
  onChange: (settings: VanitySettings) => void
  settings: VanitySettings
  title: string
}) {
  return (
    <div className="flex flex-col gap-3 border border-border/75 bg-background/35 p-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="type-control-sm" id={id}>
          {title}
        </p>
        <p className="type-meta mt-0.5 text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Select
          disabled={!settings.autoAssign}
          value={settings.strategy}
          onValueChange={(value) =>
            onChange({
              ...settings,
              strategy: value as DomainAssignmentStrategy,
            })
          }
        >
          <SelectTrigger
            aria-label={`${title}: domain for new addresses`}
            className="w-36 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[70]">
            {strategyOptions.map((option) => (
              <SelectItem
                key={option.value}
                className="text-xs"
                value={option.value}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Switch
          aria-labelledby={id}
          checked={settings.autoAssign}
          onCheckedChange={(autoAssign) => onChange({ ...settings, autoAssign })}
        />
      </div>
    </div>
  )
}

/** Releases an app's generated address, deleting its record. */
export function ReleaseHostnameDialog({
  hostname,
  onOpenChange,
}: {
  hostname: WebHostnameOverview
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const release = useMutation({
    mutationFn: () => releaseWebHostname({ data: { id: hostname.id } }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["domains"] }),
    onSuccess: () => {
      showToast({ message: `Released ${hostname.hostname}`, type: "success" })
      onOpenChange(false)
    },
  })
  return (
    <Dialog open onOpenChange={release.isPending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Release address</DialogTitle>
          <DialogDescription>
            Kiln deletes <span className="font-mono">{hostname.hostname}</span>{" "}
            from Cloudflare. Routes on {hostname.resource.name} that use it
            stop resolving.
          </DialogDescription>
        </DialogHeader>
        {release.error ? <ConfigurationError error={release.error} /> : null}
        <DialogFooter>
          <Button
            disabled={release.isPending}
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={release.isPending}
            type="button"
            variant="destructive"
            onClick={() => release.mutate()}
          >
            {release.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Trash2 />
            )}
            Release
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CloudflarePermissionsPreview({ domain }: { domain: string }) {
  return (
    <div className="space-y-4">
      <CloudflarePermissionPolicy domain={domain} />

      <div className="flex gap-2 border border-amber-500/25 bg-amber-400/8 p-3 text-amber-950/85 dark:border-amber-400/20 dark:bg-amber-400/5 dark:text-amber-100/85 light:bg-amber-400/16">
        <KeyRound className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
        <p className="type-meta">
          Add every zone Kiln should use to the token, or choose all zones. Kiln
          encrypts the token at rest, never returns it to the browser, and keeps
          every managed record DNS-only.
        </p>
      </div>
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
    <p className="border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive light:bg-destructive/10">
      {errorMessage(error)}
    </p>
  )
}
