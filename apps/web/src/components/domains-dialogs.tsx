// The Domains page's dialogs, also opened from a game server's network page. They load after the page: when the browser
// is idle, or when one first opens.
import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Effect, Fiber, Result } from "effect"
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
  type DomainConnectionOverview,
  type VanityDomainChoice,
} from "@/components/domains-shared"
import {
  defaultDomainBlacklistPatterns,
  domainInZone,
  domainNameSchema,
  validateBlacklistPatterns,
  vanityLabelSchema,
} from "@/lib/domain-schemas"
import { queryKeys } from "@/lib/query-options"
import {
  createInstanceDomain,
  deleteDomainConnection,
  discoverCloudflareDomains,
  releaseWebHostname,
  removeInstanceDomain,
  saveDomainConnection,
  updateInstanceDomain,
  type DiscoveredCloudflareZone,
  type ManagedDomainOverview,
  type WebHostnameOverview,
} from "@/server/domains"

export function CreateDomainDialog({
  domainCount,
  domains,
  onOpenChange,
  server,
}: {
  /** How many domains already point at the game server. */
  domainCount: number
  domains: ReadonlyArray<VanityDomainChoice>
  onOpenChange: (open: boolean) => void
  server: { id: string; name: string; relayId: string }
}) {
  const queryClient = useQueryClient()
  const [domain, setDomain] = React.useState(domains[0]?.domain ?? "")
  const [vanityLabel, setVanityLabel] = React.useState("")
  const [primary, setPrimary] = React.useState(false)
  const label = vanityLabel.trim()
  const parsed = label ? vanityLabelSchema.safeParse(label) : null
  const create = useMutation({
    mutationFn: () =>
      createInstanceDomain({
        data: {
          domain,
          instanceId: server.id,
          primary,
          relayId: server.relayId,
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
          <DialogTitle>Add domain</DialogTitle>
          <DialogDescription>
            An address players can join {server.name} with.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (parsed?.success !== false) create.mutate()
          }}
        >
          <VanityNameField
            domain={domain}
            domains={domains}
            error={
              parsed && !parsed.success
                ? (parsed.error.issues[0]?.message ?? "Enter a vanity name")
                : null
            }
            hint="Leave blank for a random name."
            placeholder="generated"
            value={vanityLabel}
            onDomainChange={setDomain}
            onValueChange={setVanityLabel}
          />

          {domainCount > 0 ? (
            <PrimaryDomainSwitch
              checked={primary}
              serverName={server.name}
              onCheckedChange={setPrimary}
            />
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
              disabled={create.isPending || parsed?.success === false}
              type="submit"
            >
              {create.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Plus />
              )}
              Add domain
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

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
  hint: string | null
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
      {error || hint ? (
        <span
          className={
            error
              ? "type-meta block text-destructive"
              : "type-meta block text-muted-foreground"
          }
        >
          {error ?? hint}
        </span>
      ) : null}
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
        <p className="text-xs font-medium">Main address</p>
        <p className="type-meta mt-0.5 text-muted-foreground">
          Shown on {serverName}&apos;s pages.
        </p>
      </div>
      <Switch
        aria-label="Main address"
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
          <DialogDescription>{domain.server.name}</DialogDescription>
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
            hint={null}
            value={vanityLabel}
            onDomainChange={setSuffix}
            onValueChange={setVanityLabel}
          />

          {domain.primary ? (
            domain.domainCount > 1 ? (
              <p className="type-meta text-muted-foreground">
                This is {domain.server.name}&apos;s main address.
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
            Deletes <span className="font-mono">{hostname}</span> from
            Cloudflare.
            {domain.domainCount > 1
              ? ""
              : ` Players join ${domain.server.name} by its Relay address instead.`}
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
  connections,
  hearthDomain,
  onOpenChange,
}: {
  canManagePlatform: boolean
  /** Null to connect a new token. */
  connection: DomainConnectionOverview | null
  /** Every connection the person sees, to know where defaults already are. */
  connections: ReadonlyArray<DomainConnectionOverview>
  hearthDomain: string
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const saved = connection !== null
  const [mode, setMode] = React.useState<"settings" | "permissions">("settings")
  const [name, setName] = React.useState(connection?.name ?? "Cloudflare")
  const [platform, setPlatform] = React.useState(connection?.platform ?? false)
  const [apiToken, setApiToken] = React.useState("")
  const [blacklistPatterns, setBlacklistPatterns] = React.useState(() =>
    (connection?.blacklistPatterns ?? defaultDomainBlacklistPatterns).join("\n")
  )
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
  // The first chosen domain stands in until one is picked, unless the owner
  // already has a default on another connection, which saving would move.
  const defaultElsewhere = connections.some(
    (other) =>
      other.id !== connection?.id &&
      other.platform === platform &&
      other.domains.some((domain) => domain.isDefault)
  )
  const effectiveDefault =
    selected.find((choice) => choice.zoneId === defaultZoneId) ??
    (defaultElsewhere ? undefined : selected[0])
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
    onSuccess: () => settle(`Disconnected ${connection?.name ?? "Cloudflare"}`),
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
    const reserved = Result.try(() =>
      validateBlacklistPatterns(
        blacklistPatterns
          .split(/\r?\n/u)
          .map((pattern) => pattern.trim())
          .filter(Boolean)
      )
    )
    if (Result.isFailure(reserved)) {
      showToast({ message: errorMessage(reserved.failure), type: "error" })
      return
    }
    const token = apiToken.trim()
    save.mutate({
      data: {
        apiToken: token || undefined,
        blacklistPatterns: reserved.success,
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
              <DialogTitle className="flex items-center gap-2">
                {saved ? connection.name : "Connect Cloudflare"}
                {connection?.platform ? (
                  <span className="type-technical-label border border-border/70 px-1 font-normal text-muted-foreground">
                    Kiln
                  </span>
                ) : null}
              </DialogTitle>
              <DialogDescription className="sr-only">
                A Cloudflare API token and the domains Kiln may use.
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
              <div className="space-y-1.5">
                <div className="flex h-5 items-center">
                  <label className="type-control-sm" htmlFor="connection-name">
                    Name
                  </label>
                </div>
                <Input
                  autoComplete="off"
                  id="connection-name"
                  maxLength={64}
                  name="name"
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex h-5 items-center justify-between gap-3">
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
                        aria-label="Required permissions"
                        size="icon"
                        type="button"
                        variant="outline"
                        onClick={() => setMode("permissions")}
                      >
                        <CircleHelp />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      Required permissions
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex h-6 items-center justify-between gap-3">
                <p className="type-control-sm" id="connection-zones">
                  Domains
                </p>
                <div className="flex min-w-0 items-center gap-2">
                  {tokenCheck.status === "error" && choices.length > 0 ? (
                    <span className="type-meta flex min-w-0 items-center gap-1 text-destructive">
                      <CircleAlert className="size-3 shrink-0" />
                      <span className="truncate">{tokenCheck.message}</span>
                    </span>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label="Refresh from Cloudflare"
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
                      <th className="px-3 py-2 font-normal">Domain</th>
                      <th
                        className={`${platform ? "w-36" : "w-24"} px-2 py-2 font-normal whitespace-nowrap`}
                      >
                        {platform ? (
                          <ColumnHint hint="Anyone can get an address here">
                            Kiln provided
                          </ColumnHint>
                        ) : (
                          <ColumnHint hint="New game servers and apps get an address here, like amber-forge.example.com.">
                            Vanity
                          </ColumnHint>
                        )}
                      </th>
                      <th className="w-24 px-3 py-2 font-normal">
                        <ColumnHint hint="The vanity domain new addresses use first.">
                          Default
                        </ColumnHint>
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
                          onChange={updateChoice}
                          onMakeDefault={setDefaultZoneId}
                        />
                      ))
                    ) : (
                      <tr>
                        <td
                          className="type-meta px-3 py-6 text-center text-muted-foreground"
                          colSpan={3}
                        >
                          {tokenCheck.status === "checking" ? (
                            "Loading domains…"
                          ) : tokenCheck.status === "error" ? (
                            <span className="text-destructive">
                              {tokenCheck.message}
                            </span>
                          ) : (
                            "Paste a token to see its domains."
                          )}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {canManagePlatform && !saved ? (
              <div className="flex items-center justify-between gap-4">
                <p className="type-control-sm" id="connection-owner">
                  Owner
                </p>
                <div
                  aria-labelledby="connection-owner"
                  className="flex h-8 shrink-0 items-center border border-border/75 bg-background/35 p-0.5"
                  role="radiogroup"
                >
                  {ownerOptions.map((option) => (
                    <button
                      key={option.label}
                      aria-checked={platform === option.platform}
                      className="type-control-sm h-full px-3 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 aria-checked:bg-muted aria-checked:text-foreground"
                      role="radio"
                      type="button"
                      onClick={() => setPlatform(option.platform)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Vanity domains, a person's or Kiln's, keep names from others. */}
            {selected.length > 0 ? (
              <label className="type-control-sm block space-y-1.5">
                Reserved names
                <Textarea
                  aria-label="Reserved name patterns"
                  className="min-h-20 font-mono text-xs"
                  placeholder={"{{bad-words}}\n^(admin|api|www)$"}
                  value={blacklistPatterns}
                  onChange={(event) =>
                    setBlacklistPatterns(event.currentTarget.value)
                  }
                />
              </label>
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
                  {confirmDelete ? "Confirm disconnect" : "Disconnect"}
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
                  {saved ? "Save" : "Connect"}
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

const ownerOptions = [
  { label: "Me", platform: false },
  { label: "Kiln", platform: true },
] as const

/** A column header whose meaning shows on hover. */
function ColumnHint({
  children,
  hint,
}: {
  children: React.ReactNode
  hint: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex cursor-help items-center gap-1"
          tabIndex={0}
        >
          {children}
          <CircleHelp aria-hidden className="size-3 opacity-60" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-60" side="top">
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}

const DomainZoneRow = React.memo(function DomainZoneRow({
  choice,
  isDefault,
  onChange,
  onMakeDefault,
}: {
  choice: DomainChoice
  isDefault: boolean
  onChange: (zoneId: string, change: Partial<DomainChoice>) => void
  onMakeDefault: (zoneId: string) => void
}) {
  // Fixed-height rows with block-level controls, so toggling one never
  // shifts the baseline and the dialog's height.
  return (
    <tr className="h-10">
      <td className="px-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="type-code min-w-0 truncate">{choice.domain}</span>
          {choice.missing ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <CircleAlert
                  aria-label="This token can't reach this domain"
                  className="size-3.5 shrink-0 text-amber-600 dark:text-amber-300"
                />
              </TooltipTrigger>
              <TooltipContent side="left">
                This token can&apos;t reach {choice.zoneName}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </td>
      <td className="px-2">
        <div className="flex items-center">
          <Switch
            aria-label={`Use ${choice.domain} for vanity addresses`}
            checked={choice.selected}
            onCheckedChange={(selected) =>
              onChange(choice.zoneId, { selected })
            }
          />
        </div>
      </td>
      <td className="px-3">
        <label
          className={`flex size-6 items-center justify-center ${choice.selected ? "cursor-pointer" : "cursor-not-allowed opacity-30"}`}
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
            className={`flex size-4 items-center justify-center rounded-full border peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40 ${
              isDefault ? "border-primary" : "border-input"
            }`}
          >
            <span
              className={`size-2 rounded-full ${isDefault ? "bg-primary" : "bg-transparent"}`}
            />
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
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["domains"] }),
    onSuccess: () => {
      showToast({ message: `Deleted ${hostname.hostname}`, type: "success" })
      onOpenChange(false)
    },
  })
  return (
    <Dialog open onOpenChange={release.isPending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete address</DialogTitle>
          <DialogDescription>
            Deletes <span className="font-mono">{hostname.hostname}</span> from
            Cloudflare.
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
            Delete
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
