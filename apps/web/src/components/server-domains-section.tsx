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
  domainHostname,
  domainStatusPresentation,
  type DomainSettings,
} from "@/components/domains-shared"
import {
  useInstanceIdentity,
  useInstancePermissions,
} from "@/components/instance-workspace-context"
import { StatusIndicator } from "@/components/status-indicator"
import { WorkspaceCopyValueButton } from "@/components/workspace-header"
import {
  domainSettingsQueryOptions,
  instanceDomainQueryOptions,
} from "@/lib/query-options"
import type { ManagedDomainOverview } from "@/server/domains"

const CreateDomainDialog = React.lazy(async () => ({
  default: (await import("@/components/domains-dialogs")).CreateDomainDialog,
}))
const EditDomainDialog = React.lazy(async () => ({
  default: (await import("@/components/domains-dialogs")).EditDomainDialog,
}))
const DeleteDomainDialog = React.lazy(async () => ({
  default: (await import("@/components/domains-dialogs")).DeleteDomainDialog,
}))

function selectVanityDomains(data: {
  vanityDomains: ReadonlyArray<{ domain: string; platform: boolean }>
}) {
  return data.vanityDomains
}

type DomainDialog =
  | { kind: "create" }
  | { domain: ManagedDomainOverview; kind: "delete" | "edit" }
  | null

/**
 * A game server's domains: the addresses players join it with, under the
 * vanity domains it may use. Kiln keeps their DNS records.
 */
export const ServerDomainsSection = React.memo(function ServerDomainsSection() {
  const instance = useInstanceIdentity()
  const permissions = useInstancePermissions()
  const select = React.useCallback(
    (data: DomainSettings) =>
      data.managedDomains.filter(
        (domain) =>
          domain.instanceId === instance.id &&
          domain.relayId === instance.relayId
      ),
    [instance.id, instance.relayId]
  )
  const { data: domains } = useQuery({
    ...domainSettingsQueryOptions(),
    select,
  })
  // Its owner's vanity domains too, which the Domains page's list leaves out
  // for anyone else.
  const { data: choices } = useQuery({
    ...instanceDomainQueryOptions(instance.relayId, instance.id),
    select: selectVanityDomains,
  })
  const [dialog, setDialog] = React.useState<DomainDialog>(null)
  const closeDialog = React.useCallback((open: boolean) => {
    if (!open) setDialog(null)
  }, [])
  if (!domains || !choices) return null
  const canAdd = permissions.networkWrite && choices.length > 0

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
      {domains.length > 0 ? (
        <ul aria-label="Domains" className="divide-y divide-border/60">
          {domains.map((domain) => (
            <ServerDomainRow
              key={domain.id}
              domain={domain}
              onDialog={setDialog}
            />
          ))}
        </ul>
      ) : (
        <p className="type-support px-4 py-3 text-muted-foreground">
          {choices.length > 0 ? (
            "No domains yet. Players join by the Relay address."
          ) : (
            <>
              No vanity domains yet.{" "}
              <Link
                className="text-primary-ink underline-offset-4 hover:underline"
                to="/infra/domains"
              >
                Connect Cloudflare
              </Link>{" "}
              to give this server one.
            </>
          )}
        </p>
      )}

      <React.Suspense fallback={null}>
        {dialog?.kind === "create" ? (
          <CreateDomainDialog
            domainCount={domains.length}
            domains={choices}
            server={instance}
            onOpenChange={closeDialog}
          />
        ) : null}
        {dialog?.kind === "edit" ? (
          <EditDomainDialog
            key={dialog.domain.id}
            domain={dialog.domain}
            domains={choices}
            onOpenChange={closeDialog}
          />
        ) : null}
        {dialog?.kind === "delete" ? (
          <DeleteDomainDialog
            key={dialog.domain.id}
            domain={dialog.domain}
            onOpenChange={closeDialog}
          />
        ) : null}
      </React.Suspense>
    </section>
  )
})

const ServerDomainRow = React.memo(function ServerDomainRow({
  domain,
  onDialog,
}: {
  domain: ManagedDomainOverview
  onDialog: (dialog: DomainDialog) => void
}) {
  const hostname = domainHostname(domain)
  const removing = domain.status === "removing"
  return (
    <li className="flex min-h-13 items-center gap-3 px-4 py-2">
      <div className="w-20 shrink-0">
        <StatusIndicator status={domainStatusPresentation(domain)} />
      </div>
      <div className="type-meta flex min-w-0 flex-1 items-center gap-2">
        <WorkspaceCopyValueButton label="domain" value={hostname} />
        {domain.primary && domain.domainCount > 1 ? (
          <span className="type-technical-label shrink-0 border border-border/70 px-1 text-muted-foreground">
            Main
          </span>
        ) : null}
      </div>
      <span className="type-meta hidden shrink-0 items-center gap-1 text-muted-foreground sm:inline-flex">
        {domain.srvActive ? (
          <>
            <Check aria-hidden className="size-3 text-emerald-600" />
            SRV
          </>
        ) : (
          `Port ${domain.port}`
        )}
      </span>
      {domain.canManage ? (
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
            label={`Delete ${hostname}`}
            tooltip="Delete"
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
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
