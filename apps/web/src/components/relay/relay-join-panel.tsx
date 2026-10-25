import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { encodeRelayJoinLink } from "@workspace/contracts"
import {
  Check,
  CircleAlert,
  Copy,
  Fingerprint,
  LoaderCircle,
  RefreshCw,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

import {
  DialogFeedback,
  Field,
  InstallationChoice,
} from "@/components/relay/add-relay-dialog"
import { invalidateRelayRuntimeQueries } from "@/components/relay/relay-actions"
import { useCopyFeedback } from "@/components/workspace-header"
import { queryKeys } from "@/lib/query-options"
import {
  confirmRelayJoin,
  getRelayJoin,
  openRelayJoin,
  refreshRelayJoin,
} from "@/server/relays"

// The install-command way to add a Relay: the command carries a join link,
// the new Relay announces itself, and someone confirms it here. Hearth asks
// about the join only while this is open.

type OpenedJoin = Awaited<ReturnType<typeof openRelayJoin>>
type JoinView = Awaited<ReturnType<typeof getRelayJoin>>

const POLL_MS = 2_000

// Not under the Relays list's key: invalidating that mustn't open a new join.
const relayJoinQueryKey = ["relay-join"] as const

export function RelayJoinPanel({
  joinId,
  onDone,
}: {
  // The join the installer's confirmation link names.
  joinId?: string
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const opened = useQuery({
    gcTime: 0,
    queryFn: () => openRelayJoin({ data: joinId ? { joinId } : {} }),
    queryKey: relayJoinQueryKey,
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const join = opened.data
  const polled = useQuery({
    enabled: join !== undefined,
    queryFn: () => getRelayJoin({ data: { joinId: join?.id ?? "" } }),
    queryKey: [...relayJoinQueryKey, join?.id],
    refetchInterval: (query) =>
      polling(query.state.data ?? join) ? POLL_MS : false,
  })
  const view: JoinView | undefined = polled.data ?? join
  const refresh = useMutation({
    mutationFn: () => refreshRelayJoin({ data: { joinId: join?.id ?? "" } }),
    onSuccess: (next) => {
      queryClient.setQueryData(relayJoinQueryKey, next)
    },
  })

  if (opened.error) {
    return <DialogFeedback message={opened.error.message} />
  }
  if (!join || !view) {
    return (
      <div className="flex h-24 items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
      </div>
    )
  }
  if (view.state === "paired") {
    return <JoinPaired view={view} onDone={onDone} />
  }
  if (
    view.state === "announced" ||
    view.state === "confirming" ||
    view.state === "needs_review"
  ) {
    return (
      <JoinReview
        key={`${view.id}:${view.state}`}
        cancelError={refresh.error?.message ?? null}
        cancelling={refresh.isPending}
        view={view}
        onCancel={() => refresh.mutate()}
        onConfirmed={(next) => {
          queryClient.setQueryData([...relayJoinQueryKey, view.id], next)
          void invalidateRelayRuntimeQueries(queryClient)
        }}
      />
    )
  }
  return (
    <JoinCommand
      join={join}
      expired={view.state !== "waiting" || view.expiresAt <= Date.now()}
      refreshError={refresh.error?.message ?? null}
      refreshing={refresh.isPending}
      onRefresh={() => refresh.mutate()}
    />
  )
}

// While something on the Relay's side or Hearth's can still change,
// including, until it's confirmed, whether Hearth can reach the Relay and
// whether another Relay holds its address.
function polling(view: JoinView | undefined): boolean {
  return (
    view?.state === "waiting" ||
    view?.state === "confirming" ||
    view?.state === "announced"
  )
}

// The command to run on the new machine, then waiting for its Relay.
function JoinCommand({
  expired,
  join,
  onRefresh,
  refreshError,
  refreshing,
}: {
  expired: boolean
  join: OpenedJoin
  onRefresh: () => void
  refreshError: string | null
  refreshing: boolean
}) {
  const [insecureAccepted, setInsecureAccepted] = React.useState(false)
  const command = join.secret
    ? installCommand(
        join,
        encodeRelayJoinLink({
          hearthOrigin: join.hearthOrigin,
          secret: join.secret,
        })
      )
    : null
  // A plain-HTTP address is asked about before the command shows.
  const insecure = join.hearthOrigin.startsWith("http:") && !insecureAccepted

  return (
    <div className="min-w-0 space-y-3">
      {expired || !command ? (
        <div className="flex items-center justify-between gap-3 border border-border/70 bg-background/35 px-3 py-2.5">
          <p className="type-meta text-muted-foreground">
            This command expired.
          </p>
          <Button size="sm" type="button" onClick={onRefresh}>
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            New command
          </Button>
        </div>
      ) : insecure ? (
        <div className="flex items-center gap-3 border border-amber-400/25 bg-amber-400/8 px-3 py-2.5">
          <CircleAlert className="size-3.5 shrink-0 text-amber-200 light:text-amber-800" />
          <p className="type-meta min-w-0 flex-1 text-amber-200 light:text-amber-800">
            Hearth isn't on HTTPS at this address, so the network between the
            machines could interfere.
          </p>
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setInsecureAccepted(true)}
          >
            Continue
          </Button>
        </div>
      ) : (
        <CommandLine command={command} />
      )}

      {expired ? null : (
        <div className="type-meta flex items-center gap-2 text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />
          <span className="flex-1">Waiting for the Relay</span>
          <Countdown expiresAt={join.expiresAt} />
          <Button
            size="xs"
            type="button"
            variant="ghost"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            New command
          </Button>
        </div>
      )}

      {refreshError ? <DialogFeedback message={refreshError} /> : null}
    </div>
  )
}

function installCommand(join: OpenedJoin, link: string) {
  return [
    `curl -fsSL ${join.installScript} | sh -s --`,
    join.nightly ? "--nightly" : null,
    `--join ${shellQuote(link)}`,
  ]
    .filter(Boolean)
    .join(" ")
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function Countdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  const minutes = Math.max(0, Math.ceil((expiresAt - now) / 60_000))
  return <span className="tabular-nums">{minutes} min</span>
}

// One line, however long: the copy button takes all of it.
function CommandLine({ command }: { command: string }) {
  const { copied, copy } = useCopyFeedback(command)
  return (
    <div className="flex items-center gap-2 border border-border/70 bg-background/35 py-1.5 pr-1.5 pl-3">
      <code
        className="min-w-0 flex-1 truncate font-mono text-xs"
        title={command}
      >
        {command}
      </code>
      <Button
        aria-label="Copy the command"
        size="sm"
        type="button"
        variant={copied ? "outline" : "default"}
        onClick={() => void copy()}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}

// The Relay that announced itself, to name and confirm, then how adding it
// goes.
function JoinReview({
  cancelError,
  cancelling,
  onCancel,
  onConfirmed,
  view,
}: {
  cancelError: string | null
  cancelling: boolean
  // Drops this Relay and shows a new command instead.
  onCancel: () => void
  onConfirmed: (view: JoinView) => void
  view: JoinView
}) {
  const announcement = view.announcement
  const [name, setName] = React.useState(view.intent?.name ?? "")
  const reviewed = view.observedInstallation ?? announcement?.installation
  const differs =
    reviewed?.id != null &&
    view.hearthInstallationId !== null &&
    reviewed.id !== view.hearthInstallationId
  const fixed =
    reviewed !== undefined &&
    (reviewed.fixed || announcement?.installation.replace === false)
  const [chosen, setInstallation] = React.useState<"keep" | "use">(
    view.intent?.installation ?? (differs ? "keep" : "use")
  )
  // A fixed ID other than this Kiln's can only be kept, whatever was chosen
  // before the Relay reported it, as when it restarts with one mid-review.
  const installation = differs && fixed ? "keep" : chosen
  const confirm = useMutation({
    mutationFn: () =>
      confirmRelayJoin({
        data: {
          envelopeDigest: announcement?.envelopeDigest ?? "",
          installation,
          joinId: view.id,
          name: name.trim() || null,
        },
      }),
    onSuccess: onConfirmed,
  })
  if (!announcement) return null
  const working = view.state === "confirming" && view.error === null
  const locked = view.state === "confirming"
  // Until Hearth saved the Relay; after that it can only be finished.
  const cancellable =
    view.state === "announced" ||
    (view.state === "confirming" &&
      view.error !== null &&
      (view.progress === null || view.progress === "pairing"))
  const existing = announcement.existingRelay
  const holder = announcement.addressTakenBy
  const unreachable = holder ? null : announcement.unreachable

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex items-center gap-3 border border-primary/20 bg-primary/[0.045] p-3">
        <span className="flex size-8 shrink-0 items-center justify-center border border-primary/20 bg-primary/10 text-primary-ink">
          <Fingerprint className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="type-meta text-muted-foreground">
            {new URL(announcement.controlEndpoint).host} ·{" "}
            {announcement.relayBuild}
          </p>
          <p className="font-mono text-xs break-all">
            {announcement.relayFingerprint}
          </p>
        </div>
      </div>

      {existing ? (
        <p className="type-meta text-muted-foreground">
          Hearth already has this Relay as{" "}
          <span className="text-foreground">{existing.name}</span>. Reconnecting
          keeps its game servers, Apps, and databases.
        </p>
      ) : (
        <Field label="Name" htmlFor="relay-join-name">
          <Input
            id="relay-join-name"
            maxLength={120}
            placeholder={announcement.defaultName}
            value={name}
            disabled={locked}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </Field>
      )}

      {differs && reviewed ? (
        <InstallationChoice
          choice={installation}
          disabled={locked}
          fixed={fixed}
          relayInstallationId={reviewed.id ?? ""}
          onChange={setInstallation}
        />
      ) : null}

      {holder ? (
        <div className="flex items-start gap-3 border border-amber-400/25 bg-amber-400/8 px-3 py-2.5">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-200 light:text-amber-800" />
          <p className="type-meta min-w-0 flex-1 text-amber-200 light:text-amber-800">
            <Link
              to="/relay/$relayId/info"
              params={{ relayId: holder.id }}
              className="font-medium underline underline-offset-2"
            >
              {holder.name}
            </Link>{" "}
            already uses {new URL(announcement.controlEndpoint).host}, as
            happens when a machine is set up again. Remove {holder.name} to add
            this Relay in its place; this updates once it's gone.
          </p>
        </div>
      ) : null}

      {unreachable ? (
        <div className="flex items-start gap-3 border border-amber-400/25 bg-amber-400/8 px-3 py-2.5">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-200 light:text-amber-800" />
          <p className="type-meta min-w-0 flex-1 text-amber-200 light:text-amber-800">
            {unreachable} This updates once Hearth can reach it.
          </p>
        </div>
      ) : null}

      {view.state === "needs_review" ? (
        <DialogFeedback message="The Relay's installation ID changed while it was being added. Choose again." />
      ) : null}
      {/* Saving it fails while another Relay holds its address, which
          says why already. */}
      {view.error && !holder ? <DialogFeedback message={view.error} /> : null}
      {confirm.error ? (
        <DialogFeedback message={confirm.error.message} />
      ) : null}
      {cancelError ? <DialogFeedback message={cancelError} /> : null}

      <div className="flex items-center justify-end gap-3">
        {working ? (
          <span className="type-meta flex items-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            {progressLabel(view.progress)}
          </span>
        ) : null}
        {cancellable ? (
          <Button
            type="button"
            variant="ghost"
            disabled={cancelling || confirm.isPending}
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
        <Button
          type="button"
          disabled={
            working ||
            confirm.isPending ||
            holder !== null ||
            unreachable !== null
          }
          onClick={() => confirm.mutate()}
        >
          {confirm.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Check />
          )}
          {view.error ? "Try again" : existing ? "Reconnect" : "Add Relay"}
        </Button>
      </div>
    </div>
  )
}

function progressLabel(progress: JoinView["progress"]): string {
  switch (progress) {
    case null:
    case "pairing":
      return "Pairing"
    case "saved":
      return "Connecting"
    case "connected":
    case "installation":
      return "Setting its installation ID"
  }
}

function JoinPaired({ onDone, view }: { onDone: () => void; view: JoinView }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const announced = React.useRef(false)
  React.useEffect(() => {
    if (announced.current || !view.pairedRelayId) return
    announced.current = true
    void Promise.all([
      invalidateRelayRuntimeQueries(queryClient),
      queryClient.invalidateQueries({ queryKey: queryKeys.relays }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.capabilities,
      }),
    ])
    showToast({
      type: "success",
      message: `${view.intent?.name ?? "Relay"} added`,
      duration: 4_000,
    })
    onDone()
    void navigate({
      params: { relayId: view.pairedRelayId },
      to: "/relay/$relayId/info",
    })
  }, [navigate, onDone, queryClient, view])
  return null
}
