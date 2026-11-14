import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check, Pencil, Plus, Trash2 } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"
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
import { PrimaryStar } from "@/components/primary-star"
import { StatusIndicator } from "@/components/status-indicator"
import { WorkspaceCopyValueButton } from "@/components/workspace-header"
import {
  domainSettingsQueryOptions,
  instanceDomainQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import {
  updateInstanceDomain,
  type ManagedDomainOverview,
} from "@/server/domains"

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
 * The addresses players join a game server with, under the vanity domains
 * it may use, one of them its primary. Kiln keeps their DNS records. They
 * point straight at its game port, not through the proxy its domains use.
 */
export const JoinAddressSection = React.memo(function JoinAddressSection() {
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
  const queryClient = useQueryClient()
  const makePrimary = useMutation({
    mutationFn: (domain: ManagedDomainOverview) =>
      updateInstanceDomain({
        data: {
          domain: domain.domain,
          id: domain.id,
          primary: true,
          vanityLabel: domain.vanityLabel,
        },
      }),
    onError: (error) =>
      showToast({
        description: error.message,
        message: "Could not change the primary address",
        type: "error",
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.domains.settings }),
  })
  if (!domains || !choices) return null
  // While a change saves, the list shows it.
  const primaryId = makePrimary.isPending
    ? makePrimary.variables.id
    : domains.find((domain) => domain.primary)?.id
  const canAdd = permissions.networkWrite && choices.length > 0

  return (
    <section className="border border-border/80 bg-card/55">
      <div className="flex min-h-13 flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-2">
        <h2 className="font-heading text-base font-semibold tracking-tight">
          Join address
        </h2>
        {canAdd ? (
          <Button
            size="sm"
            type="button"
            onClick={() => setDialog({ kind: "create" })}
          >
            <Plus />
            Add address
          </Button>
        ) : null}
      </div>
      {domains.length > 0 ? (
        <ul aria-label="Join addresses" className="divide-y divide-border/60">
          {domains.map((domain) => (
            <JoinAddressRow
              key={domain.id}
              busy={makePrimary.isPending}
              domain={domain}
              primary={domain.id === primaryId}
              onDialog={setDialog}
              onMakePrimary={makePrimary.mutate}
            />
          ))}
        </ul>
      ) : (
        <p className="type-support px-4 py-3 text-muted-foreground">
          {choices.length > 0 ? (
            "No address yet. Players join by the Relay address."
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

const JoinAddressRow = React.memo(function JoinAddressRow({
  busy,
  domain,
  primary,
  onDialog,
  onMakePrimary,
}: {
  busy: boolean
  domain: ManagedDomainOverview
  primary: boolean
  onDialog: (dialog: DomainDialog) => void
  onMakePrimary: (domain: ManagedDomainOverview) => void
}) {
  const hostname = domainHostname(domain)
  const removing = domain.status === "removing"
  return (
    <li className="flex min-h-13 items-center gap-3 py-2 pr-4 pl-2">
      <PrimaryStar
        disabled={busy || removing || !domain.canManage}
        name={hostname}
        noun="address"
        primary={primary}
        onMakePrimary={() => onMakePrimary(domain)}
      />
      <div className="w-20 shrink-0">
        <StatusIndicator status={domainStatusPresentation(domain)} />
      </div>
      <div className="type-meta flex min-w-0 flex-1 items-center gap-2">
        {/* What players type: the port only when no SRV record carries it. */}
        <WorkspaceCopyValueButton label="address" value={domain.address} />
      </div>
      {domain.srvActive ? (
        <span className="type-meta hidden shrink-0 items-center gap-1 text-muted-foreground sm:inline-flex">
          <Check aria-hidden className="size-3 text-emerald-600" />
          SRV
        </span>
      ) : null}
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
