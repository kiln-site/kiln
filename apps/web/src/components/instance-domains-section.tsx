import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check, Pencil, Plus, Trash2 } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  domainStatusPresentation,
  type DomainDialogTarget,
} from "@/components/domains-shared"
import { StatusIndicator } from "@/components/status-indicator"
import { WorkspaceCopyValueButton } from "@/components/workspace-header"
import { instanceDomainQueryOptions } from "@/lib/query-options"
import type { InstanceAddressOverview } from "@/server/domains"

const CreateDomainDialog = React.lazy(async () => ({
  default: (await import("@/components/domains-dialogs")).CreateDomainDialog,
}))
const EditDomainDialog = React.lazy(async () => ({
  default: (await import("@/components/domains-dialogs")).EditDomainDialog,
}))
const DeleteDomainDialog = React.lazy(async () => ({
  default: (await import("@/components/domains-dialogs")).DeleteDomainDialog,
}))

function selectAddresses(data: {
  addresses: ReadonlyArray<InstanceAddressOverview>
}) {
  return data.addresses
}

function selectVanityDomains(data: {
  vanityDomains: ReadonlyArray<{ domain: string; platform: boolean }>
}) {
  return data.vanityDomains
}

type DomainDialog =
  | { kind: "create" }
  | { domain: InstanceAddressOverview; kind: "delete" | "edit" }
  | null

/**
 * An instance's domains: the addresses of its own, under the vanity domains
 * it may use, whose DNS records Kiln keeps. Players join a game server by
 * one; any other instance's wait for a web route to answer on them.
 */
export const InstanceDomainsSection = React.memo(
  function InstanceDomainsSection({
    canWrite,
    instance,
    resourceType,
  }: {
    canWrite: boolean
    instance: { id: string; name: string; relayId: string }
    resourceType: "app" | "instance"
  }) {
    // Its addresses and where more may go come in one read, which lists its
    // owner's vanity domains too.
    const query = instanceDomainQueryOptions(
      instance.relayId,
      instance.id,
      resourceType
    )
    const { data: domains } = useQuery({ ...query, select: selectAddresses })
    const { data: choices, isError } = useQuery({
      ...query,
      select: selectVanityDomains,
    })
    const [dialog, setDialog] = React.useState<DomainDialog>(null)
    const closeDialog = React.useCallback((open: boolean) => {
      if (!open) setDialog(null)
    }, [])
    const target = React.useCallback(
      (domain: InstanceAddressOverview): DomainDialogTarget => ({
        domain: domain.domain,
        domainCount: domains?.length ?? 1,
        game: domain.game,
        hostname: domain.hostname,
        id: domain.id,
        instanceId: instance.id,
        name: instance.name,
        primary: domain.primary,
        relayId: instance.relayId,
        vanityLabel: domain.vanityLabel,
      }),
      [domains?.length, instance.id, instance.name, instance.relayId]
    )
    if (isError) return null
    const game = resourceType === "instance"
    const canAdd = canWrite && (choices?.length ?? 0) > 0

    return (
      <section className="border border-border/80 bg-card/55">
        <div className="flex min-h-13 flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-2">
          <h2 className="font-heading text-base font-semibold tracking-tight">
            Domains
          </h2>
          {canAdd ? (
            <Button
              size="sm"
              type="button"
              onClick={() => setDialog({ kind: "create" })}
            >
              <Plus />
              Add domain
            </Button>
          ) : null}
        </div>
        {!domains || !choices ? (
          // Most instances have one: its row's height is held while it loads.
          <div aria-hidden className="min-h-13" />
        ) : domains.length > 0 ? (
          <ul aria-label="Domains" className="divide-y divide-border/60">
            {domains.map((domain) => (
              <InstanceDomainRow
                key={domain.id}
                canManage={canWrite}
                domain={domain}
                domainCount={domains.length}
                onDialog={setDialog}
              />
            ))}
          </ul>
        ) : (
          <p className="type-support flex min-h-13 flex-wrap items-center gap-x-1 px-4 py-3 text-muted-foreground">
            {choices.length > 0 ? (
              game ? (
                "No domains yet. Players join by the Relay address."
              ) : (
                "No domains yet."
              )
            ) : (
              <>
                No vanity domains yet.{" "}
                <Link
                  className="text-primary-ink underline-offset-4 hover:underline"
                  to="/infra/domains"
                >
                  Connect Cloudflare
                </Link>{" "}
                to give this {game ? "server" : "App"} one.
              </>
            )}
          </p>
        )}

        <React.Suspense fallback={null}>
          {dialog?.kind === "create" && domains && choices ? (
            <CreateDomainDialog
              domainCount={domains.length}
              domains={choices}
              instance={instance}
              resourceType={resourceType}
              onOpenChange={closeDialog}
            />
          ) : null}
          {dialog?.kind === "edit" && choices ? (
            <EditDomainDialog
              key={dialog.domain.id}
              domain={target(dialog.domain)}
              domains={choices}
              onOpenChange={closeDialog}
            />
          ) : null}
          {dialog?.kind === "delete" ? (
            <DeleteDomainDialog
              key={dialog.domain.id}
              domain={target(dialog.domain)}
              onOpenChange={closeDialog}
            />
          ) : null}
        </React.Suspense>
      </section>
    )
  }
)

const InstanceDomainRow = React.memo(function InstanceDomainRow({
  canManage,
  domain,
  domainCount,
  onDialog,
}: {
  canManage: boolean
  domain: InstanceAddressOverview
  domainCount: number
  onDialog: (dialog: DomainDialog) => void
}) {
  const { hostname } = domain
  const removing = domain.status === "removing"
  // A game server's address goes and leaves its name to the route. Any
  // other is only its route's while one answers on it.
  const held = domain.routed && !domain.game
  return (
    <li className="flex min-h-13 items-center gap-3 px-4 py-2">
      <div className="w-20 shrink-0">
        <StatusIndicator status={domainStatusPresentation(domain)} />
      </div>
      <div className="type-meta flex min-w-0 flex-1 items-center gap-2">
        <WorkspaceCopyValueButton label="domain" value={hostname} />
        {domain.primary && domainCount > 1 ? (
          <span className="type-technical-label shrink-0 border border-border/70 px-1 text-muted-foreground">
            Main
          </span>
        ) : null}
      </div>
      <span className="type-meta hidden shrink-0 items-center gap-1 text-muted-foreground sm:inline-flex">
        {domain.game ? (
          domain.srvActive ? (
            <>
              <Check aria-hidden className="size-3 text-emerald-600" />
              SRV
            </>
          ) : (
            `Port ${domain.port}`
          )
        ) : domain.routed ? (
          <>
            <Check aria-hidden className="size-3 text-emerald-600" />
            Web route
          </>
        ) : (
          "No web route"
        )}
      </span>
      {canManage ? (
        <div className="flex shrink-0 items-center">
          <RowButton
            disabled={removing}
            label={`Edit ${hostname}`}
            tooltip="Edit"
            onClick={() => onDialog({ domain, kind: "edit" })}
          >
            <Pencil />
          </RowButton>
          <RowButton
            destructive
            disabled={held}
            label={`Delete ${hostname}`}
            tooltip={held ? "Remove its web route to delete it" : "Delete"}
            onClick={() => onDialog({ domain, kind: "delete" })}
          >
            <Trash2 />
          </RowButton>
        </div>
      ) : null}
    </li>
  )
})

function RowButton({
  children,
  destructive = false,
  disabled = false,
  label,
  onClick,
  tooltip,
}: {
  children: React.ReactNode
  destructive?: boolean
  disabled?: boolean
  label: string
  onClick: () => void
  tooltip: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button shows no tooltip; its wrapper does. */}
        <span className="inline-flex" tabIndex={disabled ? 0 : undefined}>
          <Button
            aria-label={label}
            className={
              destructive
                ? "text-destructive hover:bg-destructive/10 hover:text-destructive"
                : "text-muted-foreground hover:text-primary-ink"
            }
            disabled={disabled}
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
