import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import {
  ArrowUpToLine,
  EllipsisVertical,
  ExternalLink,
  Globe,
  KeyRound,
  LoaderCircle,
  Plus,
  Trash2,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

import { DataTableActionGroup } from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import { InfoHint, InfoSection } from "@/components/info-page"
import { SectionIconButton } from "@/components/instance-container-section"
import { StatusIndicator } from "@/components/status-indicator"
import {
  normalizeTld,
  useSetTunnels,
  useTunnelSave,
  type TunnelOverview,
} from "@/components/tunnel/tunnel-data"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import type { DataTableSource } from "@/lib/data-table-source"
import { notALoginField } from "@/lib/not-a-login-field"
import { configureTailscaleIntegration } from "@/server/tunnels"

// A tunnel's TLDs, on its Info page, with its Tailscale login behind
// Configure; and the login's fields, which adding a tunnel uses too.

const MAXIMUM_TLDS = 16

/** The Tailscale login's fields, for a new tunnel or one that has one. */
export interface TailscaleLoginValues {
  clientId: string
  clientSecret: string
  tag: string
}

export function initialLogin(
  tunnel?: Pick<TunnelOverview, "integration">
): TailscaleLoginValues {
  return {
    clientId: tunnel?.integration?.clientId ?? "",
    clientSecret: "",
    tag: tunnel?.integration?.tags[0] ?? "tag:kiln",
  }
}

/** Whether the login can be checked: a new one needs its secret. */
export function loginComplete(
  values: TailscaleLoginValues,
  secretRequired: boolean
): boolean {
  const secret = values.clientSecret.trim()
  return (
    values.clientId.trim().length > 0 &&
    values.tag.trim().length > 0 &&
    (secretRequired ? secret.length >= 20 : !secret || secret.length >= 20)
  )
}

export function TailscaleLoginFields({
  compact = false,
  disabled,
  hasSecret,
  values,
  onChange,
}: {
  /** One field a row, for a narrow column. */
  compact?: boolean
  disabled?: boolean
  /** A saved secret stays when this is left blank. */
  hasSecret: boolean
  values: TailscaleLoginValues
  onChange: (values: TailscaleLoginValues) => void
}) {
  const set =
    (field: keyof TailscaleLoginValues) =>
    (event: React.ChangeEvent<HTMLInputElement>) =>
      onChange({ ...values, [field]: event.target.value })
  return (
    <div className={compact ? "grid gap-3" : "grid gap-4 sm:grid-cols-2"}>
      <label className="block">
        <span className="mb-2 block text-xs font-medium">OAuth client ID</span>
        <Input
          {...notALoginField}
          disabled={disabled}
          value={values.clientId}
          onChange={set("clientId")}
          placeholder="kAbCdEfGh123CNTRL"
          className="font-mono"
        />
      </label>
      <label className="block">
        <span className="mb-2 block text-xs font-medium">Device tag</span>
        <Input
          {...notALoginField}
          disabled={disabled}
          value={values.tag}
          onChange={set("tag")}
          placeholder="tag:kiln"
          className="font-mono"
        />
      </label>
      <label className={compact ? "block" : "block sm:col-span-2"}>
        <span className="mb-2 block text-xs font-medium">
          OAuth client secret
        </span>
        <Input
          {...notALoginField}
          type="password"
          disabled={disabled}
          value={values.clientSecret}
          onChange={set("clientSecret")}
          placeholder={
            hasSecret
              ? "Unchanged"
              : "tskey-client-kAbCdEfGh123CNTRL-a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"
          }
          className="font-mono"
        />
      </label>
    </div>
  )
}

const credentialPermissions = [
  { group: "General", permission: "DNS" },
  { group: "Devices", permission: "Core" },
  { group: "Devices", permission: "Routes" },
  { group: "Keys", permission: "Auth Keys" },
] as const

/** What the OAuth client needs from Tailscale, and where to make one. */
export function TailscaleLoginHelp({ tag }: { tag: string }) {
  const shown = tag.trim().startsWith("tag:")
    ? tag.trim()
    : `tag:${tag.trim() || "kiln"}`
  return (
    <div>
      <h3 className="text-xs font-semibold">What the OAuth client needs</h3>
      <Button
        asChild
        type="button"
        size="sm"
        variant="outline"
        className="mt-3 w-full"
      >
        <a
          href="https://console.tailscale.com/admin/settings/trust-credentials/add"
          target="_blank"
          rel="noreferrer"
        >
          Create an OAuth client
          <ExternalLink />
        </a>
      </Button>
      <ul className="mt-3 divide-y divide-border/70 border border-border/70">
        {credentialPermissions.map(({ group, permission }) => (
          <li
            key={`${group}:${permission}`}
            className="flex items-center justify-between gap-3 px-2.5 py-2"
          >
            <span className="flex min-w-0 items-baseline gap-1">
              <span className="type-technical-label shrink-0 text-muted-foreground">
                {group} /
              </span>
              <span className="truncate text-xs font-medium">{permission}</span>
            </span>
            <span className="type-technical-label shrink-0 text-primary-ink">
              Write
            </span>
          </li>
        ))}
      </ul>
      <p className="type-meta mt-3 leading-relaxed text-muted-foreground">
        For Devices → Core and Keys → Auth Keys, select{" "}
        <span className="font-mono text-foreground">{shown}</span> under Tags.
      </p>
    </div>
  )
}

/**
 * A tunnel's TLDs, in a table: generated names go under the first, and
 * Tailscale's split DNS sends every one to its gateways. Its Tailscale login
 * opens from the header, since it's set once and rarely changed.
 */
export const TunnelTldsSection = React.memo(function TunnelTldsSection({
  canManage,
  tunnel,
}: {
  canManage: boolean
  tunnel: TunnelOverview
}) {
  const save = useTunnelSave()
  const [dialog, setDialog] = React.useState<
    | { kind: "add" }
    | { kind: "login" }
    | { domain: string; kind: "remove" }
    | null
  >(null)
  const close = React.useCallback((open: boolean) => {
    if (!open) setDialog(null)
  }, [])
  // While a change saves, the table shows it.
  const domains =
    save.isPending && save.variables?.tunnel.id === tunnel.id
      ? (save.variables.change.domains ?? tunnel.domains)
      : tunnel.domains
  const saveDomains = React.useCallback(
    (next: ReadonlyArray<string>, doing: string, done: string) =>
      save.mutateAsync({ change: { domains: next }, doing, done, tunnel }),
    [save, tunnel]
  )
  // Its toast says how it went.
  const makeFirst = React.useCallback(
    (domain: string) =>
      save.mutate({
        change: {
          domains: [
            domain,
            ...tunnel.domains.filter((other) => other !== domain),
          ],
        },
        doing: `Moving generated names under .${domain} on every gateway`,
        done: `Generated names are under .${domain}`,
        tunnel,
      }),
    [save, tunnel]
  )
  const rows = React.useMemo(
    () =>
      domains.map((domain, index) => ({
        domain,
        first: index === 0,
        names: tunnel.names.filter((name) => name.domain === domain).length,
      })),
    [domains, tunnel.names]
  )
  const busy = save.isPending
  const definition = React.useMemo(
    () =>
      defineDataTable({
        ariaLabel: "TLDs",
        columns: tldColumnHelper.columns([
          tldColumnHelper.accessor((row) => row.domain, {
            id: "tld",
            header: "TLD",
            enableSorting: false,
            cell: ({ row }) => (
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-[0.8125rem]">
                  .{row.original.domain}
                </span>
                {row.original.first ? (
                  <Badge variant="outline" className="type-meta shrink-0">
                    Generated names
                  </Badge>
                ) : null}
              </span>
            ),
            meta: dataTableColumnMeta({ width: "minmax(0,1fr)" }),
          }),
          tldColumnHelper.accessor((row) => row.names, {
            id: "names",
            header: "Names",
            enableSorting: false,
            cell: ({ row }) => (
              <span className="type-meta text-muted-foreground">
                {row.original.names}{" "}
                {row.original.names === 1 ? "name" : "names"}
              </span>
            ),
            meta: dataTableColumnMeta({ hideBelow: "sm", width: "6.5rem" }),
          }),
          tldColumnHelper.display({
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }) =>
              canManage ? (
                <TldActions
                  busy={busy}
                  domain={row.original.domain}
                  first={row.original.first}
                  only={rows.length === 1}
                  onMakeFirst={makeFirst}
                  onRemove={(domain) => setDialog({ domain, kind: "remove" })}
                />
              ) : null,
            meta: dataTableColumnMeta(
              { width: "2.75rem" },
              { cellClassName: "px-1 sm:px-2", headerClassName: "px-1 sm:px-2" }
            ),
          }),
        ]),
        getRowId: (row) => row.domain,
      }),
    [busy, canManage, makeFirst, rows.length]
  )
  const source = React.useMemo(
    (): DataTableSource<TldRow> => ({
      body: { kind: "ready" },
      refreshing: false,
      rows,
    }),
    [rows]
  )
  const loginError = tunnel.integration?.lastError ?? null
  return (
    <InfoSection
      icon={<Globe />}
      title="TLDs"
      status={
        <>
          <InfoHint label="About TLDs" title="TLDs">
            <p>
              Everything this tunnel connects gets a name under the first TLD,
              like{" "}
              <span className="font-mono text-foreground">
                app.{domains[0]}
              </span>
              . Devices on your tailnet reach it by that name.
            </p>
            <p>
              Tailscale sends every TLD here to this tunnel's gateways, so
              aliases can use any of them.
            </p>
          </InfoHint>
          {loginError ? (
            <StatusIndicator
              status={{
                detail: loginError,
                label: "Tailscale login failing",
                tone: "danger",
              }}
            />
          ) : null}
        </>
      }
      action={
        canManage ? (
          <>
            {domains.length < MAXIMUM_TLDS ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setDialog({ kind: "add" })}
              >
                <Plus />
                Add TLD
              </Button>
            ) : null}
            <SectionIconButton
              label="Tailscale login"
              onClick={() => setDialog({ kind: "login" })}
            >
              <KeyRound />
            </SectionIconButton>
          </>
        ) : null
      }
      content="flush"
    >
      <div className="[&_tbody]:overflow-visible [&_tbody]:overscroll-auto">
        <DataTable definition={definition} emptyState={null} source={source} />
      </div>
      {dialog?.kind === "add" ? (
        <AddTldDialog
          domains={tunnel.domains}
          onAdd={(domain) =>
            saveDomains(
              [...tunnel.domains, domain],
              `Adding .${domain} on every gateway`,
              `.${domain} is added`
            )
          }
          onOpenChange={close}
        />
      ) : null}
      {dialog?.kind === "remove" ? (
        <RemoveTldDialog
          domain={dialog.domain}
          first={tunnel.domains[0] === dialog.domain}
          next={tunnel.domains.find((other) => other !== dialog.domain) ?? ""}
          onRemove={() =>
            saveDomains(
              tunnel.domains.filter((other) => other !== dialog.domain),
              `Removing .${dialog.domain} from every gateway`,
              `.${dialog.domain} is removed`
            )
          }
          onOpenChange={close}
        />
      ) : null}
      {dialog?.kind === "login" ? (
        <TailscaleLoginDialog tunnel={tunnel} onOpenChange={close} />
      ) : null}
    </InfoSection>
  )
})

interface TldRow {
  domain: string
  first: boolean
  names: number
}

const tldColumnHelper = createDataTableColumnHelper<TldRow>()

function TldActions({
  busy,
  domain,
  first,
  only,
  onMakeFirst,
  onRemove,
}: {
  busy: boolean
  domain: string
  first: boolean
  only: boolean
  onMakeFirst: (domain: string) => void
  onRemove: (domain: string) => void
}) {
  if (first && only) return null
  return (
    <DataTableActionGroup>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Actions for .${domain}`}
            disabled={busy}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {first ? null : (
            <DropdownMenuItem onSelect={() => onMakeFirst(domain)}>
              <ArrowUpToLine /> Use for generated names
            </DropdownMenuItem>
          )}
          {only ? null : (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => onRemove(domain)}
            >
              <Trash2 /> Remove
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
}

function AddTldDialog({
  domains,
  onAdd,
  onOpenChange,
}: {
  domains: ReadonlyArray<string>
  onAdd: (domain: string) => Promise<unknown>
  onOpenChange: (open: boolean) => void
}) {
  const [value, setValue] = React.useState("")
  const add = useMutation({
    mutationFn: onAdd,
    onSuccess: () => onOpenChange(false),
  })
  const domain = normalizeTld(value)
  const taken = domains.includes(domain)
  return (
    <Dialog open onOpenChange={(open) => !add.isPending && onOpenChange(open)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a TLD</DialogTitle>
          <DialogDescription>
            Tailscale sends names under it to this tunnel. Aliases can use it;
            generated names stay under the first TLD.
          </DialogDescription>
        </DialogHeader>
        <form
          id="add-tld"
          onSubmit={(event) => {
            event.preventDefault()
            if (!domain || taken) return
            add.mutate(domain)
          }}
        >
          <Input
            {...notALoginField}
            autoFocus
            aria-label="TLD"
            className="font-mono"
            disabled={add.isPending}
            placeholder="test"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {taken ? (
            <p className="mt-2 text-xs text-muted-foreground">
              .{domain} is already one of this tunnel's TLDs.
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={add.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="add-tld"
            disabled={!domain || taken || add.isPending}
          >
            {add.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Plus />
            )}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RemoveTldDialog({
  domain,
  first,
  next,
  onOpenChange,
  onRemove,
}: {
  domain: string
  first: boolean
  /** The TLD generated names move under, when it's the first. */
  next: string
  onOpenChange: (open: boolean) => void
  onRemove: () => Promise<unknown>
}) {
  const remove = useMutation({
    mutationFn: onRemove,
    onSuccess: () => onOpenChange(false),
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => !remove.isPending && onOpenChange(open)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove .{domain}?</DialogTitle>
          <DialogDescription>
            Names under .{domain} stop resolving, and aliases under it are
            forgotten.
            {first ? ` Generated names move under .${next}.` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Trash2 />
            )}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A tunnel's Tailscale login, checked with Tailscale as it's saved. */
function TailscaleLoginDialog({
  onOpenChange,
  tunnel,
}: {
  onOpenChange: (open: boolean) => void
  tunnel: TunnelOverview
}) {
  const [values, setValues] = React.useState(() => initialLogin(tunnel))
  const setTunnels = useSetTunnels()
  const save = useMutation({
    mutationFn: () =>
      configureTailscaleIntegration({
        data: {
          clientId: values.clientId.trim(),
          clientSecret: values.clientSecret.trim() || undefined,
          domains: tunnel.domains,
          id: tunnel.id,
          previousDomains: tunnel.domains,
          tag: values.tag.trim(),
        },
      }),
    onSuccess: (configured) => {
      setTunnels(configured.result)
      showToast({
        message: `${tunnel.name}'s Tailscale login is checked and saved`,
        type: "success",
      })
      onOpenChange(false)
    },
  })
  const hasSecret = tunnel.integration !== null
  const changed =
    values.clientId.trim() !== (tunnel.integration?.clientId ?? "") ||
    values.tag.trim() !== (tunnel.integration?.tags[0] ?? "") ||
    values.clientSecret.trim().length > 0
  return (
    <Dialog open onOpenChange={(open) => !save.isPending && onOpenChange(open)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Tailscale login</DialogTitle>
          <DialogDescription>
            The OAuth client {tunnel.name}'s gateways log in with and set split
            DNS through. It's checked with Tailscale as it saves.
          </DialogDescription>
        </DialogHeader>
        <form
          id="tailscale-login"
          className="grid gap-5 md:grid-cols-[minmax(0,1fr)_16rem]"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <div className="min-w-0">
            {tunnel.integration?.lastError ? (
              <p
                className="mb-4 border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive light:bg-destructive/10"
                role="alert"
              >
                {tunnel.integration.lastError}
              </p>
            ) : null}
            <TailscaleLoginFields
              compact
              disabled={save.isPending}
              hasSecret={hasSecret}
              values={values}
              onChange={setValues}
            />
            {save.error ? (
              <p className="mt-3 text-xs text-destructive" role="alert">
                {save.error.message}
              </p>
            ) : null}
          </div>
          <aside className="border-t pt-4 md:border-t-0 md:border-l md:pt-0 md:pl-5">
            <TailscaleLoginHelp tag={values.tag} />
          </aside>
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="tailscale-login"
            disabled={
              !changed || !loginComplete(values, !hasSecret) || save.isPending
            }
          >
            {save.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <KeyRound />
            )}
            {save.isPending ? "Checking…" : "Check and save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
