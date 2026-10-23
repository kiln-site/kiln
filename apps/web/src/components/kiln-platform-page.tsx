import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import {
  CircleAlert,
  LoaderCircle,
  RotateCw,
  ScrollText,
  Wrench,
  Zap,
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
import { showToast } from "@workspace/ui/components/sonner"
import type {
  RelayPlatformService,
  RelayPlatformServiceRole,
  RelayPlatformStatus,
} from "@workspace/contracts"

import { HearthMark } from "@/components/hearth-mark"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { InfraSyncButton } from "@/components/infra-sync-button"
import { DatabaseKindIcon } from "@/components/instance-kind-icon"
import { messageFrom } from "@/components/relay/relay-actions"
import { StatusIndicator } from "@/components/status-indicator"
import { WorkspaceSummaryCard } from "@/components/workspace-summary-card"
import {
  kilnPlatformLogsQueryOptions,
  kilnPlatformQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import { runKilnPlatformAction, type KilnPlatformHost } from "@/server/platform"

const serviceCopy: Record<
  RelayPlatformServiceRole,
  { description: string; noun: string; restart: string; title: string }
> = {
  cache: {
    description: "Valkey, which Hearth caches Relay reads in",
    noun: "the cache",
    restart: "Hearth reads from its Relays directly until the cache is back.",
    title: "Cache",
  },
  database: {
    description: "MySQL, which holds Hearth's users, settings, and catalog",
    noun: "the database",
    restart:
      "Hearth can't sign anyone in or save changes until MySQL is back, usually within a minute. Game servers, Apps, and databases keep running.",
    title: "Database",
  },
  hearth: {
    description: "This panel",
    noun: "Hearth",
    restart:
      "Everyone's pages reconnect once Hearth is back, usually within a minute. Game servers, Apps, and databases keep running.",
    title: "Hearth",
  },
}

/**
 * Kiln's own services, from the Relay on their Docker host. A Relay that
 * installed them can restart and repair them; Compose or Coolify deployments
 * are shown read-only.
 */
export const KilnPlatformPage = React.memo(function KilnPlatformPage() {
  const queryClient = useQueryClient()
  const { data } = useSuspenseQuery(kilnPlatformQueryOptions())

  return (
    <div className="mx-auto grid w-full max-w-[90rem] gap-6 px-3 pb-10 sm:px-5">
      <div className="flex items-center justify-between gap-4">
        <p className="type-meta min-w-0 text-muted-foreground">
          Hearth, its database, and its cache, as the Relay beside them sees
          them.
        </p>
        <InfraSyncButton
          label="Refresh Kiln's services"
          sync={() =>
            queryClient.invalidateQueries({
              queryKey: queryKeys.kilnPlatform.all,
            })
          }
        />
      </div>
      {data.hosts.length === 0 ? (
        <NoPlatformHost />
      ) : (
        data.hosts.map((host) => (
          <PlatformHost key={host.relayId} host={host} />
        ))
      )}
    </div>
  )
})

function NoPlatformHost() {
  return (
    <section className="rounded-xl border border-dashed border-border/80 px-5 py-10 text-center">
      <p className="type-card-title">No Relay reports Kiln's services</p>
      <p className="type-meta mx-auto mt-2 max-w-xl text-muted-foreground">
        A Relay shows Hearth and its database here when it runs on their
        Docker host, whether it installed them or they were deployed with
        Compose or Coolify. Relays older than this Hearth don't report them.
      </p>
    </section>
  )
}

const PlatformHost = React.memo(function PlatformHost({
  host,
}: {
  host: KilnPlatformHost
}) {
  const status = host.status
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="type-section-title">On {host.relayName}</h2>
        {status ? <ManagementBadge status={status} /> : null}
        {status && status.phase !== "ready" ? (
          <Badge variant="outline">{phaseLabels[status.phase]}</Badge>
        ) : null}
        <span className="flex-1" />
        {status?.canManage ? (
          <RepairButton relayId={host.relayId} />
        ) : null}
      </div>
      {host.error ? (
        <PlatformNotice>{host.error}</PlatformNotice>
      ) : status?.issue ? (
        <PlatformNotice>{status.issue}</PlatformNotice>
      ) : null}
      {status ? (
        <div className="grid gap-3 lg:grid-cols-3">
          {status.services.map((service) => (
            <PlatformServiceCard
              key={service.role}
              relayId={host.relayId}
              service={service}
            />
          ))}
        </div>
      ) : null}
      {status ? <PlatformFootnote status={status} /> : null}
    </section>
  )
})

const phaseLabels: Record<RelayPlatformStatus["phase"], string> = {
  blocked: "Needs attention",
  installing: "Installing",
  maintenance: "Hearth held stopped",
  ready: "Running",
}

function ManagementBadge({ status }: { status: RelayPlatformStatus }) {
  return (
    <Badge variant="secondary">
      {status.management === "relay"
        ? "Installed by this Relay"
        : "Deployed outside Kiln"}
    </Badge>
  )
}

function PlatformNotice({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/8 px-3 py-2.5 text-xs leading-5 text-amber-200"
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  )
}

function PlatformFootnote({ status }: { status: RelayPlatformStatus }) {
  if (status.management === "external") {
    return (
      <p className="type-meta text-muted-foreground">
        Compose or Coolify manages these containers, so Kiln only shows them.
        Change them where they were deployed.
      </p>
    )
  }
  return (
    <p className="type-meta text-muted-foreground">
      Keep a copy of this installation's secrets somewhere safe: on the
      Relay's host, run{" "}
      <code className="font-mono text-foreground/85">
        docker exec kiln-relay kiln-relay platform export-kit &gt;
        kiln-recovery.json
      </code>
      . With a platform backup, it restores Kiln on a new host.
    </p>
  )
}

const PlatformServiceCard = React.memo(function PlatformServiceCard({
  relayId,
  service,
}: {
  relayId: string
  service: RelayPlatformService
}) {
  const copy = serviceCopy[service.role]
  const [dialog, setDialog] = React.useState<"logs" | "restart" | null>(null)
  return (
    <WorkspaceSummaryCard
      className="sm:flex-col sm:items-stretch"
      icon={serviceIcon(service.role)}
      title={copy.title}
      titleAccessory={<StatusIndicator status={servicePresentation(service)} />}
    >
      <p className="type-meta mt-0.5 text-muted-foreground">
        {copy.description}
      </p>
      <dl className="type-meta mt-3 grid gap-1 text-muted-foreground">
        <ServiceFact label="Image" value={service.image} />
        {service.version ? (
          <ServiceFact label="Version" value={service.version} />
        ) : null}
        <ServiceFact label="Container" value={service.container} />
        {service.startedAt ? (
          <ServiceFact
            label="Started"
            value={new Date(service.startedAt).toLocaleString()}
          />
        ) : null}
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        {service.container ? (
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setDialog("logs")}
          >
            <ScrollText /> Logs
          </Button>
        ) : null}
        {service.actions.includes("restart") ? (
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setDialog("restart")}
          >
            <RotateCw /> Restart
          </Button>
        ) : null}
      </div>
      {dialog === "logs" ? (
        <PlatformLogsDialog
          relayId={relayId}
          role={service.role}
          onClose={() => setDialog(null)}
        />
      ) : dialog === "restart" ? (
        <RestartServiceDialog
          relayId={relayId}
          role={service.role}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </WorkspaceSummaryCard>
  )
})

function ServiceFact({
  label,
  value,
}: {
  label: string
  value: string | null
}) {
  return (
    <div className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
      <dt>{label}</dt>
      <dd className="truncate font-mono text-foreground/85" title={value ?? ""}>
        {value ?? "—"}
      </dd>
    </div>
  )
}

function serviceIcon(role: RelayPlatformServiceRole) {
  switch (role) {
    case "hearth":
      return <HearthMark className="size-5" />
    case "database":
      return <DatabaseKindIcon className="size-4" />
    case "cache":
      return <Zap className="size-4" />
  }
}

function servicePresentation(
  service: RelayPlatformService
): IdentityStatusPresentation {
  switch (service.state) {
    case "running":
      return { label: "Running", tone: "success" }
    case "starting":
      return { label: "Starting", pulse: true, tone: "info" }
    case "restarting":
      return { label: "Restarting", pulse: true, tone: "info" }
    case "updating":
      return { label: "Updating", pulse: true, tone: "info" }
    case "unhealthy":
      return {
        detail: "Its health check is failing; its logs may say why.",
        label: "Unhealthy",
        tone: "danger",
      }
    case "stopped":
      return { label: "Stopped", tone: "warning" }
    case "missing":
      return {
        detail: "Its container doesn't exist.",
        label: "Missing",
        tone: "danger",
      }
  }
}

function RepairButton({ relayId }: { relayId: string }) {
  const queryClient = useQueryClient()
  const repair = useMutation({
    mutationFn: () =>
      runKilnPlatformAction({ data: { action: "repair", relayId } }),
    onError: (cause) =>
      showToast({
        type: "error",
        message: messageFrom(cause, "Couldn't repair Kiln's services."),
      }),
    onSuccess: (status) => {
      showToast({
        type: status.issue ? "info" : "success",
        message: status.issue ?? "Kiln's services are running",
      })
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.kilnPlatform.all }),
  })
  return (
    <Button
      disabled={repair.isPending}
      size="sm"
      type="button"
      variant="outline"
      onClick={() => repair.mutate()}
    >
      {repair.isPending ? <LoaderCircle className="animate-spin" /> : <Wrench />}
      Repair
    </Button>
  )
}

// Mounted only while open.
function RestartServiceDialog({
  relayId,
  role,
  onClose,
}: {
  relayId: string
  role: RelayPlatformServiceRole
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const copy = serviceCopy[role]
  const restart = useMutation({
    mutationFn: () =>
      runKilnPlatformAction({ data: { action: "restart", relayId, role } }),
    onSuccess: () => {
      onClose()
      showToast({
        type: "info",
        message: `Restarting ${copy.noun}`,
        duration: 4_000,
      })
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.kilnPlatform.all }),
  })
  const pending = restart.isPending
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Restart {copy.noun}?</DialogTitle>
          <DialogDescription>{copy.restart}</DialogDescription>
        </DialogHeader>
        {restart.error ? (
          <p role="alert" className="type-meta text-destructive">
            {messageFrom(restart.error, `Couldn't restart ${copy.noun}.`)}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={pending}
            type="button"
            variant="ghost"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            disabled={pending}
            type="button"
            onClick={() => restart.mutate()}
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
            Restart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PlatformLogsDialog({
  relayId,
  role,
  onClose,
}: {
  relayId: string
  role: RelayPlatformServiceRole
  onClose: () => void
}) {
  const logs = useQuery(kilnPlatformLogsQueryOptions(relayId, role))
  const end = React.useRef<HTMLDivElement>(null)
  const lines = logs.data?.lines
  React.useLayoutEffect(() => {
    end.current?.scrollIntoView({ block: "end" })
  }, [lines])
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="grid max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{serviceCopy[role].title} logs</DialogTitle>
          <DialogDescription>Its last 500 lines.</DialogDescription>
        </DialogHeader>
        <div className="min-h-48 overflow-auto rounded-lg border border-border/70 bg-background/70 p-3">
          {logs.isPending ? (
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          ) : logs.error ? (
            <p role="alert" className="type-meta text-destructive">
              {messageFrom(logs.error, "Couldn't read its logs.")}
            </p>
          ) : lines && lines.length > 0 ? (
            <pre className="font-mono text-[11px] leading-5 whitespace-pre-wrap break-all text-foreground/85">
              {lines.join("\n")}
            </pre>
          ) : (
            <p className="type-meta text-muted-foreground">No output yet.</p>
          )}
          <div ref={end} />
        </div>
        <DialogFooter>
          <Button
            disabled={logs.isFetching}
            type="button"
            variant="outline"
            onClick={() => void logs.refetch()}
          >
            {logs.isFetching ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RotateCw />
            )}
            Refresh
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
