import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { encodeRelayJoinLink } from "@workspace/contracts"
import {
  Check,
  CircleAlert,
  Copy,
  Dices,
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
import { generateVanityCandidates } from "@/server/vanity-names"

// The install-command way to add a Relay: the command carries a join link,
// the new Relay announces itself, and someone confirms it here. Hearth asks
// about the join only while this is open.

type OpenedJoin = Awaited<ReturnType<typeof openRelayJoin>>
type JoinView = Awaited<ReturnType<typeof getRelayJoin>>
export type JoinMethod = "install" | "docker"

const POLL_MS = 2_000

// Not under the Relays list's key: invalidating that mustn't open a new join.
const relayJoinQueryKey = ["relay-join"] as const

export function RelayJoinPanel({
  method,
  onDone,
}: {
  method: JoinMethod
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const opened = useQuery({
    gcTime: 0,
    queryFn: () => openRelayJoin(),
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
      polling(query.state.data?.state ?? join?.state) ? POLL_MS : false,
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
      <div className="flex h-32 items-center justify-center text-muted-foreground">
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
        view={view}
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
      method={method}
      refreshError={refresh.error?.message ?? null}
      refreshing={refresh.isPending}
      onRefresh={() => refresh.mutate()}
    />
  )
}

function polling(state: JoinView["state"] | undefined): boolean {
  return state === "waiting" || state === "confirming"
}

// The command to run on the new machine, and the addresses in it.
function JoinCommand({
  expired,
  join,
  method,
  onRefresh,
  refreshError,
  refreshing,
}: {
  expired: boolean
  join: OpenedJoin
  method: JoinMethod
  onRefresh: () => void
  refreshError: string | null
  refreshing: boolean
}) {
  const [hearthOrigin, setHearthOrigin] = React.useState(join.hearthOrigin)
  const [relayHost, setRelayHost] = React.useState("")
  const [insecureAccepted, setInsecureAccepted] = React.useState(false)
  const origin = parsedOrigin(hearthOrigin)
  const insecure = origin?.startsWith("http:") === true
  const link =
    join.link && origin
      ? encodeRelayJoinLink({ ...join.link, hearthOrigin: origin })
      : null
  const command = link
    ? method === "install"
      ? installCommand(join, link, relayHost.trim())
      : dockerCommand(join, link, relayHost.trim())
    : null

  return (
    <div className="space-y-4">
      {expired || !command ? (
        <div className="flex items-center justify-between gap-3 border border-border/70 bg-background/35 px-3 py-2.5">
          <p className="type-meta text-muted-foreground">
            {origin ? "This command expired." : "Enter Hearth's address."}
          </p>
          {origin ? (
            <Button size="sm" type="button" onClick={onRefresh}>
              <RefreshCw className={refreshing ? "animate-spin" : undefined} />
              New command
            </Button>
          ) : null}
        </div>
      ) : insecure && !insecureAccepted ? (
        <div className="flex items-start gap-3 border border-amber-400/25 bg-amber-400/8 px-3 py-2.5">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-200 light:text-amber-800" />
          <p className="type-meta min-w-0 flex-1 text-amber-200 light:text-amber-800">
            Hearth isn't on HTTPS at this address, so someone on the network
            between the two machines could interfere with joining.
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
        <CommandBlock command={command} />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Hearth address" htmlFor="relay-join-hearth">
          <Input
            id="relay-join-hearth"
            className="type-meta font-mono"
            value={hearthOrigin}
            spellCheck={false}
            onChange={(event) => setHearthOrigin(event.currentTarget.value)}
          />
        </Field>
        <Field label="This machine's address" htmlFor="relay-join-host">
          <Input
            id="relay-join-host"
            className="type-meta font-mono"
            placeholder={method === "install" ? "Its public IP" : "Required"}
            value={relayHost}
            spellCheck={false}
            onChange={(event) => setRelayHost(event.currentTarget.value)}
          />
        </Field>
      </div>

      {refreshError ? <DialogFeedback message={refreshError} /> : null}

      <div className="type-meta flex items-center justify-between gap-3 text-muted-foreground">
        <span className="flex items-center gap-2">
          {expired ? null : <LoaderCircle className="size-3.5 animate-spin" />}
          {expired ? "Expired" : "Waiting for the Relay"}
        </span>
        {expired ? null : (
          <span className="flex items-center gap-2">
            <Countdown expiresAt={join.expiresAt} />
            <Button
              aria-label="New command"
              size="icon-sm"
              type="button"
              variant="ghost"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            </Button>
          </span>
        )}
      </div>
    </div>
  )
}

function installCommand(join: OpenedJoin, link: string, relayHost: string) {
  return [
    `curl -fsSL ${join.installScript} | sh -s -- --node`,
    join.nightly ? "--nightly" : null,
    relayHost ? `--relay-host ${shellQuote(relayHost)}` : null,
    `--join ${shellQuote(link)}`,
  ]
    .filter(Boolean)
    .join(" ")
}

function dockerCommand(join: OpenedJoin, link: string, relayHost: string) {
  return [
    "docker run -d --name kiln-relay --restart unless-stopped",
    "-v /var/run/docker.sock:/var/run/docker.sock -v kiln-relay-data:/data",
    "-p 4100:4100 -p 2022:2022",
    `-e KILN_RELAY_HOST=${shellQuote(relayHost || "<this machine's address>")}`,
    `-e KILN_RELAY_JOIN=${shellQuote(link)}`,
    join.relayImage,
  ].join(" ")
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function parsedOrigin(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/u, "")
  const candidate = /^https?:\/\//u.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  if (!URL.canParse(candidate)) return null
  const url = new URL(candidate)
  return (url.protocol === "https:" || url.protocol === "http:") &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
    ? url.origin
    : null
}

function Countdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  const minutes = Math.max(0, Math.ceil((expiresAt - now) / 60_000))
  return <span className="tabular-nums">{minutes} min left</span>
}

function CommandBlock({ command }: { command: string }) {
  const { copied, copy } = useCopyFeedback(command)
  return (
    <div className="flex items-start gap-2 border border-border/70 bg-background/35 p-3">
      <code className="min-w-0 flex-1 font-mono text-xs leading-5 break-all">
        {command}
      </code>
      <Button
        aria-label="Copy the command"
        size="icon-sm"
        type="button"
        variant="ghost"
        onClick={() => void copy()}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}

// The Relay that announced itself, to name and confirm, then how adding it
// goes.
function JoinReview({
  onConfirmed,
  view,
}: {
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
  const [installation, setInstallation] = React.useState<"keep" | "use">(
    view.intent?.installation ?? (differs ? "keep" : "use")
  )
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

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 border border-primary/20 bg-primary/[0.045] p-3">
        <span className="flex size-8 shrink-0 items-center justify-center border border-primary/20 bg-primary/10 text-primary-ink">
          <Fingerprint className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {announcement.existingRelay?.name ?? announcement.relayName}
          </p>
          <p className="type-meta font-mono break-all text-muted-foreground">
            {announcement.relayFingerprint}
          </p>
        </div>
      </div>
      <dl className="type-meta grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Address</dt>
          <dd className="mt-1 font-mono break-all">
            {new URL(announcement.controlEndpoint).host}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Version</dt>
          <dd className="mt-1 font-mono">{announcement.relayBuild}</dd>
        </div>
      </dl>
      {announcement.existingRelay ? (
        <p className="type-meta text-muted-foreground">
          Hearth already has this Relay as{" "}
          <span className="text-foreground">
            {announcement.existingRelay.name}
          </span>
          . Its game servers, Apps, and databases stay; Hearth's connection to
          it is replaced.
        </p>
      ) : null}

      {announcement.existingRelay ? null : (
        <Field label="Name" htmlFor="relay-join-name">
          <div className="flex gap-2">
            <Input
              id="relay-join-name"
              maxLength={120}
              placeholder="Automatic"
              value={name}
              disabled={locked}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <Button
              aria-label="Generate a name"
              size="icon"
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => setName(generatedName())}
            >
              <Dices />
            </Button>
          </div>
        </Field>
      )}

      {differs && reviewed ? (
        <InstallationChoice
          choice={installation}
          disabled={locked}
          fixed={reviewed.fixed || !announcement.installation.replace}
          relayInstallationId={reviewed.id ?? ""}
          onChange={setInstallation}
        />
      ) : null}

      {view.state === "needs_review" ? (
        <DialogFeedback message="The Relay's installation ID changed while it was being added. Choose again." />
      ) : null}
      {view.error ? <DialogFeedback message={view.error} /> : null}
      {confirm.error ? (
        <DialogFeedback message={confirm.error.message} />
      ) : null}

      <div className="flex items-center justify-end gap-3">
        {working ? (
          <span className="type-meta flex items-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            {progressLabel(view.progress)}
          </span>
        ) : null}
        <Button
          type="button"
          disabled={working || confirm.isPending}
          onClick={() => confirm.mutate()}
        >
          {confirm.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Check />
          )}
          {view.error
            ? "Try again"
            : announcement.existingRelay
              ? "Reconnect"
              : "Add Relay"}
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

function generatedName(): string {
  const [candidate = "relay"] = generateVanityCandidates([], 1)
  return candidate
    .split("-")
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ")
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
      message: `${view.announcement?.existingRelay?.name ?? "Relay"} added`,
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
