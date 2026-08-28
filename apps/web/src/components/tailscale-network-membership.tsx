import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Effect } from "effect"
import {
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Globe2,
  KeyRound,
  LoaderCircle,
  Network,
  Pencil,
  RefreshCw,
  Route,
  Search,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  Unplug,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { ensuringPromise, forkPromise } from "@/effect/promise"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { dismissToast, showToast } from "@workspace/ui/components/sonner"
import { Switch } from "@workspace/ui/components/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  WorkspaceDataTable,
  WorkspaceTableCell,
  WorkspaceTableHead,
  WorkspaceTableHeading,
  createWorkspaceTableSearchStore,
  useWorkspaceTableSearchInput,
} from "@/components/workspace-data-table"
import type { WorkspaceTableSearchStore } from "@/components/workspace-data-table"
import { TailscaleRelayUpdateHint } from "@/components/tailscale-relay-update-hint"
import {
  queryKeys,
  relaySnapshotQueryOptions,
  tailscaleStacksQueryOptions,
} from "@/lib/query-options"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import {
  defaultTailscaleHostname,
  selectTailscaleServers,
  tailscaleServerKey,
} from "@/lib/tailscale-selectors"
import type { TailscaleServer } from "@/lib/tailscale-selectors"
import {
  showTailscaleOperationError,
  showTailscaleOperationProgress,
  showTailscaleOperationSuccess,
  tailscaleOperationToastId,
  type TailscaleOperation,
} from "@/lib/tailscale-operation-toasts"
import {
  configureTailscaleIntegration,
  getTailscaleIntegrationStatus,
  previewTailscaleIntegration,
  saveTailscaleStack,
  syncTailscaleIntegration,
  type TailscaleStackOverview,
} from "@/server/tailscale"

type StackBinding = TailscaleStackOverview["bindings"][number]
type SaveStackInput = Parameters<typeof saveTailscaleStack>[0]["data"]

const emptyServers: Array<TailscaleServer> = []

export function TailscaleNetworkMembershipPage({
  highlightedServerKey,
  stackId,
}: {
  highlightedServerKey?: string
  stackId: string
}) {
  const [searchStore] = React.useState(createWorkspaceTableSearchStore)
  const { data } = useSuspenseQuery(tailscaleStacksQueryOptions())
  const { stacks } = data
  const { data: servers = emptyServers, isPending: serversPending } = useQuery({
    ...relaySnapshotQueryOptions(),
    notifyOnChangeProps: ["data", "isPending"],
    select: selectTailscaleServers,
  })
  const stack = stacks.find((candidate) => candidate.id === stackId)
  const save = useStackMembershipMutation()

  if (!stack) {
    return (
      <CenteredNetworkState>
        This Tailscale network is no longer available.
      </CenteredNetworkState>
    )
  }

  if (stack.cleanup) {
    return (
      <CenteredNetworkState>
        Removing {stack.name}. {stack.cleanup.pendingRelays} Relay
        {stack.cleanup.pendingRelays === 1 ? "" : "s"} still pending cleanup.
      </CenteredNetworkState>
    )
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background/55 p-3 sm:p-5">
      <section className="mx-auto max-w-[90rem] overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
        <TailscaleOAuthSetup key={stack.id} stack={stack} />
        <MembershipToolbar searchStore={searchStore} stackName={stack.name} />
        {save.error ? (
          <p
            className="border-b border-destructive/25 bg-destructive/5 px-4 py-2 text-xs text-destructive"
            role="alert"
          >
            {errorMessage(save.error)}
          </p>
        ) : null}
        <TailscaleMembershipTable
          highlightedServerKey={highlightedServerKey}
          pending={save.isPending}
          searchStore={searchStore}
          servers={servers}
          serversPending={serversPending}
          stack={stack}
          onSave={(bindings, authKey) =>
            save.mutateAsync({ authKey, bindings, stack })
          }
        />
      </section>
    </main>
  )
}

const TailscaleOAuthSetup = React.memo(function TailscaleOAuthSetup({
  stack,
}: {
  stack: TailscaleStackOverview
}) {
  const queryClient = useQueryClient()
  const sync = useMutation({
    mutationFn: () => syncTailscaleIntegration({ data: { id: stack.id } }),
    onMutate: () => {
      showToast({
        id: tailscaleSetupToastId(stack.id),
        message: "Syncing Tailscale…",
        type: "loading",
      })
    },
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.tailscaleStacks, next)
      dismissToast(tailscaleSetupToastId(stack.id))
      showToast({
        id: tailscaleSetupToastId(stack.id),
        message: "Tailscale configuration synced",
        type: "success",
      })
    },
    onError: async (cause) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.tailscaleStacks,
      })
      dismissToast(tailscaleSetupToastId(stack.id))
      showToast({
        id: tailscaleSetupToastId(stack.id),
        message: errorMessage(cause),
        type: "error",
      })
    },
  })
  const [open, setOpen] = React.useState(false)
  const integration = stack.integration
  const needsAttention = Boolean(integration?.lastError)

  return (
    <>
      <div className="flex min-h-16 items-center gap-3 border-b bg-background/40 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border/70 bg-background/60">
          {needsAttention ? (
            <TriangleAlert className="size-4 text-amber-400" />
          ) : integration ? (
            <ShieldCheck className="size-4 text-emerald-400" />
          ) : (
            <KeyRound className="size-4 text-primary" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-xs font-semibold">Tailnet setup</h2>
            <span
              className={
                needsAttention
                  ? "type-technical-label text-amber-400"
                  : integration
                    ? "type-technical-label text-emerald-400"
                    : "type-technical-label text-muted-foreground"
              }
            >
              {needsAttention
                ? "Needs attention"
                : integration
                  ? "Connected"
                  : "Not configured"}
            </span>
          </div>
          <p className="type-meta truncate font-mono text-muted-foreground">
            {integration
              ? `${integration.clientId} · ${integration.tags.join(", ")}`
              : `*.${stack.domain}`}
          </p>
        </div>
        {integration ? (
          <Button
            type="button"
            size="sm"
            variant={needsAttention ? "default" : "outline"}
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            {sync.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            Sync
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={integration ? "ghost" : "default"}
          onClick={() => setOpen(true)}
        >
          {integration ? <Settings2 /> : <KeyRound />}
          {integration ? "Manage" : "Set up"}
        </Button>
      </div>
      {open ? (
        <TailscaleSetupDialog open stack={stack} onOpenChange={setOpen} />
      ) : null}
    </>
  )
})

type SetupPreview = Awaited<ReturnType<typeof previewTailscaleIntegration>>

const setupSteps = ["Credentials", "Domain", "DNS", "Routes", "Ready"] as const

const TailscaleSetupDialog = React.memo(function TailscaleSetupDialog({
  open,
  stack,
  onOpenChange,
}: {
  open: boolean
  stack: TailscaleStackOverview
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [step, setStep] = React.useState(0)
  const [clientId, setClientId] = React.useState(
    stack.integration?.clientId ?? ""
  )
  const [clientSecret, setClientSecret] = React.useState("")
  const [tag, setTag] = React.useState(stack.integration?.tags[0] ?? "tag:kiln")
  const [domain, setDomain] = React.useState(stack.domain)
  const [preview, setPreview] = React.useState<SetupPreview | null>(null)
  const [dnsApproved, setDnsApproved] = React.useState(false)
  const [routesApproved, setRoutesApproved] = React.useState(false)
  const [complete, setComplete] = React.useState(false)
  const clientIdFieldId = React.useId()
  const clientSecretFieldId = React.useId()
  const tagFieldId = React.useId()
  const domainFieldId = React.useId()

  const authenticate = useMutation({
    mutationFn: (candidateDomain: string) =>
      previewTailscaleIntegration({
        data: {
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          domain: normalizeTailscaleDomain(candidateDomain),
          id: stack.id,
          tag: tag.trim(),
        },
      }),
    onSuccess: (result) => setPreview(result),
  })
  const apply = useMutation({
    mutationFn: async () => {
      const nextDomain = normalizeTailscaleDomain(domain)
      if (nextDomain !== stack.domain) {
        await saveTailscaleStack({
          data: stackSaveInput(stack, stack.bindings, undefined, nextDomain),
        })
      }
      const input = {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        domain: nextDomain,
        id: stack.id,
        previousDomain: stack.domain,
        tag: tag.trim(),
      }
      const result = await Effect.runPromise(
        Effect.tryPromise({
          try: () => configureTailscaleIntegration({ data: input }),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            isNetworkChangeError(cause)
              ? Effect.tryPromise({
                  try: () => recoverTailscaleIntegrationStatus(stack.id, cause),
                  catch: (recoveryCause) => recoveryCause,
                })
              : Effect.fail(cause)
          )
        )
      )
      if (!tailscaleSetupVerified(result.inspection)) {
        throw new Error(
          "Tailscale accepted the changes, but DNS or route verification is still pending"
        )
      }
      return result
    },
    onMutate: () => {
      showToast({
        id: tailscaleSetupToastId(stack.id),
        message: "Configuring your Tailnet…",
        type: "loading",
      })
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.tailscaleStacks, result.stacks)
      setPreview((current) =>
        current ? { ...current, inspection: result.inspection } : current
      )
      setClientSecret("")
      setComplete(true)
      dismissToast(tailscaleSetupToastId(stack.id))
      showToast({
        id: tailscaleSetupToastId(stack.id),
        message: "Your Tailscale network is ready",
        type: "success",
      })
    },
    onError: async (cause) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.tailscaleStacks,
      })
      dismissToast(tailscaleSetupToastId(stack.id))
      showToast({
        id: tailscaleSetupToastId(stack.id),
        message: errorMessage(cause),
        type: "error",
      })
    },
  })

  const inspection = preview?.inspection
  const pending = authenticate.isPending || apply.isPending
  const error = authenticate.error ?? apply.error

  const goBack = () => {
    if (pending || complete) return
    setStep((current) => Math.max(0, current - 1))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!pending) onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border/70 px-5 pt-5 pb-4">
          <DialogTitle>Set up Tailscale</DialogTitle>
          <DialogDescription>
            Connect {stack.name} to its private DNS and routes.
          </DialogDescription>
        </DialogHeader>
        <SetupStepRail activeStep={step} complete={complete} />
        <div className="min-h-[22rem] px-5 py-5">
          {step === 0 ? (
            <SetupCredentialsStep
              authenticated={Boolean(preview)}
              clientId={clientId}
              clientIdFieldId={clientIdFieldId}
              clientSecret={clientSecret}
              clientSecretFieldId={clientSecretFieldId}
              error={authenticate.error}
              pending={authenticate.isPending}
              tag={tag}
              tagFieldId={tagFieldId}
              onClientIdChange={(value) => {
                setClientId(value)
                setPreview(null)
                authenticate.reset()
              }}
              onClientSecretChange={(value) => {
                setClientSecret(value)
                setPreview(null)
                authenticate.reset()
              }}
              onTagChange={(value) => {
                setTag(value)
                setPreview(null)
                authenticate.reset()
              }}
              onAuthenticate={() =>
                authenticate.mutate(normalizeTailscaleDomain(domain))
              }
            />
          ) : null}
          {step === 1 ? (
            <SetupDomainStep
              domain={domain}
              fieldId={domainFieldId}
              onChange={(value) => {
                setDomain(value)
                setDnsApproved(false)
                setRoutesApproved(false)
              }}
            />
          ) : null}
          {step === 2 && inspection ? (
            <SetupDnsStep
              approved={dnsApproved}
              domain={normalizeTailscaleDomain(domain)}
              inspection={inspection}
              onApprovedChange={setDnsApproved}
            />
          ) : null}
          {step === 3 && inspection ? (
            <SetupRoutesStep
              approved={routesApproved}
              routes={inspection.routes}
              onApprovedChange={setRoutesApproved}
            />
          ) : null}
          {step === 4 ? (
            <SetupReadyStep
              complete={complete}
              domain={normalizeTailscaleDomain(domain)}
              inspection={inspection}
              networkName={stack.name}
              pending={apply.isPending}
            />
          ) : null}
          {error && step !== 0 ? (
            <SetupResult
              tone="error"
              title="Setup could not continue"
              value={errorMessage(error)}
            />
          ) : null}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            disabled={pending || complete || step === 0}
            onClick={goBack}
          >
            <ChevronLeft />
            Back
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {complete ? "Close" : "Cancel"}
            </Button>
            {!complete ? (
              <Button
                type="button"
                disabled={
                  pending ||
                  (step === 0 && !preview) ||
                  (step === 1 && !normalizeTailscaleDomain(domain)) ||
                  (step === 2 && !dnsApproved) ||
                  (step === 3 && !routesApproved)
                }
                onClick={() => {
                  if (step === 1) {
                    authenticate.mutate(normalizeTailscaleDomain(domain), {
                      onSuccess: () => setStep(2),
                    })
                    return
                  }
                  if (step === 4) {
                    apply.mutate()
                    return
                  }
                  setStep((current) =>
                    Math.min(setupSteps.length - 1, current + 1)
                  )
                }}
              >
                {pending ? (
                  <LoaderCircle className="animate-spin" />
                ) : step === 4 ? (
                  <Check />
                ) : (
                  <ChevronRight />
                )}
                {step === 0
                  ? "Continue"
                  : step === 1
                    ? "Review DNS"
                    : step === 2
                      ? "Review routes"
                      : step === 3
                        ? "Final review"
                        : "Apply setup"}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

function SetupStepRail({
  activeStep,
  complete,
}: {
  activeStep: number
  complete: boolean
}) {
  return (
    <ol
      className="grid grid-cols-5 border-b border-border/70 bg-background/35"
      aria-label="Tailscale setup progress"
    >
      {setupSteps.map((label, index) => {
        const finished = complete || index < activeStep
        const active = index === activeStep
        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className="relative flex min-w-0 flex-col items-center gap-1 px-1 py-3"
          >
            <span
              className={
                finished
                  ? "grid size-5 place-items-center rounded-full bg-emerald-500/15 text-emerald-400"
                  : active
                    ? "grid size-5 place-items-center rounded-full bg-primary text-primary-foreground"
                    : "grid size-5 place-items-center rounded-full border border-border text-muted-foreground"
              }
            >
              {finished ? (
                <Check className="size-3" />
              ) : (
                <span className="type-meta font-mono">{index + 1}</span>
              )}
            </span>
            <span
              className={
                active || finished
                  ? "type-label truncate"
                  : "type-meta truncate text-muted-foreground"
              }
            >
              {label}
            </span>
            {active ? (
              <span className="absolute inset-x-3 bottom-0 h-0.5 bg-primary" />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

function SetupCredentialsStep({
  authenticated,
  clientId,
  clientIdFieldId,
  clientSecret,
  clientSecretFieldId,
  error,
  pending,
  tag,
  tagFieldId,
  onAuthenticate,
  onClientIdChange,
  onClientSecretChange,
  onTagChange,
}: {
  authenticated: boolean
  clientId: string
  clientIdFieldId: string
  clientSecret: string
  clientSecretFieldId: string
  error: Error | null
  pending: boolean
  tag: string
  tagFieldId: string
  onAuthenticate: () => void
  onClientIdChange: (value: string) => void
  onClientSecretChange: (value: string) => void
  onTagChange: (value: string) => void
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <SetupHeading icon={KeyRound} title="OAuth credentials" />
        <Button asChild type="button" size="sm" variant="ghost">
          <a
            href="https://console.tailscale.com/admin/settings/trust-credentials/add"
            target="_blank"
            rel="noreferrer"
          >
            Create credential
            <ExternalLink />
          </a>
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SetupField label="Client ID" fieldId={clientIdFieldId}>
          <Input
            id={clientIdFieldId}
            aria-label="OAuth client ID"
            value={clientId}
            onChange={(event) => onClientIdChange(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            placeholder="k…CNTRL"
            className="font-mono"
          />
        </SetupField>
        <SetupField label="Client secret" fieldId={clientSecretFieldId}>
          <Input
            id={clientSecretFieldId}
            aria-label="OAuth client secret"
            value={clientSecret}
            onChange={(event) => onClientSecretChange(event.target.value)}
            type="password"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            placeholder="tskey-client-…"
            className="font-mono"
          />
        </SetupField>
      </div>
      <SetupField label="Device tag" fieldId={tagFieldId}>
        <Input
          id={tagFieldId}
          aria-label="Tailscale device tag"
          value={tag}
          onChange={(event) => onTagChange(event.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          placeholder="tag:kiln"
          className="max-w-xs font-mono"
        />
      </SetupField>
      <div className="flex min-h-16 items-center gap-3 border border-border/70 bg-background/35 p-3">
        <div className="min-w-0 flex-1">
          {authenticated ? (
            <SetupResult
              tone="success"
              title="Authentication successful"
              value="The credential has every scope and the selected device tag Kiln needs."
            />
          ) : error ? (
            <SetupResult
              tone="error"
              title="Authentication failed"
              value={errorMessage(error)}
            />
          ) : (
            <div className="space-y-1">
              <p className="type-meta text-muted-foreground">
                Write: General → DNS · Devices → Core · Devices → Routes · Keys
                → Auth Keys
              </p>
              <p className="type-meta text-muted-foreground">
                Use <span className="font-mono">{tag || "tag:kiln"}</span> for
                Core and Auth Keys.
              </p>
            </div>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant={authenticated ? "outline" : "default"}
          disabled={
            pending || !clientId.trim() || !clientSecret.trim() || !tag.trim()
          }
          onClick={onAuthenticate}
        >
          {pending ? (
            <LoaderCircle className="animate-spin" />
          ) : authenticated ? (
            <Check />
          ) : (
            <KeyRound />
          )}
          {authenticated ? "Verified" : "Authenticate"}
        </Button>
      </div>
    </div>
  )
}

function SetupDomainStep({
  domain,
  fieldId,
  onChange,
}: {
  domain: string
  fieldId: string
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-5">
      <SetupHeading icon={Globe2} title="Private domain" />
      <SetupField label="Network TLD or subdomain" fieldId={fieldId}>
        <Input
          id={fieldId}
          aria-label="Network TLD or subdomain"
          value={domain}
          onChange={(event) => onChange(event.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="test or mc.server"
          className="max-w-sm font-mono"
          autoFocus
        />
      </SetupField>
      <div className="border border-border/70 bg-background/35 p-4">
        <span className="type-technical-label text-muted-foreground">
          Server address
        </span>
        <p className="mt-2 truncate font-mono text-sm">
          1.21.11.paper.{normalizeTailscaleDomain(domain) || "test"}
        </p>
      </div>
    </div>
  )
}

function SetupDnsStep({
  approved,
  domain,
  inspection,
  onApprovedChange,
}: {
  approved: boolean
  domain: string
  inspection: SetupPreview["inspection"]
  onApprovedChange: (approved: boolean) => void
}) {
  const {
    currentResolvers,
    desiredResolvers,
    previousDomain,
    previousResolvers,
  } = inspection.dns
  const replaces =
    currentResolvers.length > 0 &&
    !sameStrings(currentResolvers, desiredResolvers)
  return (
    <div className="space-y-4">
      <SetupHeading icon={Globe2} title="Split DNS" />
      <div className="divide-y divide-border/70 border border-border/70">
        <SetupChangeRow
          label={`.${domain}`}
          before={
            currentResolvers.length ? currentResolvers.join(", ") : "Not set"
          }
          after={desiredResolvers.join(", ") || "Waiting for a Tailnet IP"}
          tone={replaces ? "warning" : "default"}
        />
        {previousDomain && previousResolvers.length ? (
          <SetupChangeRow
            label={`.${previousDomain}`}
            before={previousResolvers.join(", ")}
            after="Removed"
            tone="warning"
          />
        ) : null}
      </div>
      {replaces ? (
        <SetupResult
          tone="warning"
          title={`.${domain} already points somewhere else`}
          value="Continuing replaces that Tailnet DNS entry. It does not change DNS outside Tailscale."
        />
      ) : null}
      <SetupApproval
        checked={approved}
        title={replaces ? "Replace this DNS entry" : "Create this DNS entry"}
        onCheckedChange={onApprovedChange}
      />
    </div>
  )
}

function SetupRoutesStep({
  approved,
  routes,
  onApprovedChange,
}: {
  approved: boolean
  routes: SetupPreview["inspection"]["routes"]
  onApprovedChange: (approved: boolean) => void
}) {
  return (
    <div className="space-y-4">
      <SetupHeading icon={Route} title="Private routes" />
      <div className="divide-y divide-border/70 border border-border/70">
        {routes.map((route) => (
          <div
            key={`${route.hostname}:${route.subnet}`}
            className="flex items-center gap-3 px-3 py-3"
          >
            <span
              className={
                route.approved
                  ? "size-2 rounded-full bg-emerald-400"
                  : route.advertised
                    ? "size-2 rounded-full bg-amber-400"
                    : "size-2 rounded-full bg-muted-foreground"
              }
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{route.hostname}</p>
              <p className="type-meta font-mono text-muted-foreground">
                {route.subnet}
              </p>
            </div>
            <span className="type-technical-label text-muted-foreground">
              {route.approved
                ? "Approved"
                : route.advertised
                  ? "Ready to approve"
                  : "Waiting to advertise"}
            </span>
          </div>
        ))}
      </div>
      <SetupApproval
        checked={approved}
        title="Allow Kiln to approve these private routes"
        onCheckedChange={onApprovedChange}
      />
    </div>
  )
}

function SetupReadyStep({
  complete,
  domain,
  inspection,
  networkName,
  pending,
}: {
  complete: boolean
  domain: string
  inspection: SetupPreview["inspection"] | undefined
  networkName: string
  pending: boolean
}) {
  if (complete) {
    return (
      <div className="grid min-h-[18rem] place-items-center text-center">
        <div>
          <span className="mx-auto grid size-14 place-items-center rounded-full bg-emerald-500/15 text-emerald-400">
            <CheckCircle2 className="size-7" />
          </span>
          <h3 className="mt-4 text-lg font-semibold">Tailnet ready</h3>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            *.{domain}
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-5">
      <SetupHeading icon={CheckCircle2} title="Ready to apply" />
      <div className="divide-y divide-border/70 border border-border/70">
        <SetupSummaryRow label="Network" value={networkName} />
        <SetupSummaryRow label="Private domain" value={`*.${domain}`} />
        <SetupSummaryRow
          label="DNS resolvers"
          value={inspection?.dns.desiredResolvers.join(", ") || "Pending"}
        />
        <SetupSummaryRow
          label="Private routes"
          value={`${inspection?.routes.length ?? 0} node${inspection?.routes.length === 1 ? "" : "s"}`}
        />
      </div>
      {pending ? (
        <SetupResult
          tone="pending"
          title="Applying Tailnet configuration"
          value="Kiln is updating DNS, approving routes, and verifying every node."
        />
      ) : null}
    </div>
  )
}

function SetupHeading({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-4 text-primary" />
      <h3 className="text-sm font-semibold">{title}</h3>
    </div>
  )
}

function SetupField({
  children,
  fieldId,
  label,
}: {
  children: React.ReactNode
  fieldId: string
  label: string
}) {
  return (
    <label className="block min-w-0" htmlFor={fieldId}>
      <span className="type-label mb-1.5 block">{label}</span>
      {children}
    </label>
  )
}

function SetupResult({
  title,
  tone,
  value,
}: {
  title: string
  tone: "error" | "pending" | "success" | "warning"
  value: string
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "success"
          ? "border border-emerald-500/25 bg-emerald-500/8 px-3 py-2.5 text-emerald-300"
          : tone === "error"
            ? "border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-destructive"
            : tone === "warning"
              ? "border border-amber-500/25 bg-amber-500/8 px-3 py-2.5 text-amber-300"
              : "border border-primary/25 bg-primary/8 px-3 py-2.5 text-foreground"
      }
    >
      <p className="text-xs font-semibold">{title}</p>
      <p className="type-meta mt-1">{value}</p>
    </div>
  )
}

function SetupApproval({
  checked,
  title,
  onCheckedChange,
}: {
  checked: boolean
  title: string
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 border border-border/70 bg-background/35 px-3 py-3">
      <span className="text-xs font-medium">{title}</span>
      <Switch
        checked={checked}
        aria-label={title}
        onCheckedChange={onCheckedChange}
      />
    </label>
  )
}

function SetupChangeRow({
  after,
  before,
  label,
  tone,
}: {
  after: string
  before: string
  label: string
  tone: "default" | "warning"
}) {
  return (
    <div className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
      <span className="truncate font-mono text-xs">{label}</span>
      <span
        className={
          tone === "warning"
            ? "type-code truncate text-amber-300"
            : "type-code truncate text-muted-foreground"
        }
      >
        {before}
      </span>
      <ChevronRight className="hidden size-3 text-muted-foreground sm:block" />
      <span className="type-code truncate text-foreground">{after}</span>
    </div>
  )
}

function SetupSummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="type-code truncate">{value}</span>
    </div>
  )
}

export function GameServerTailscaleSection({
  server,
}: {
  server: InstanceWorkspaceInstance
}) {
  const { data } = useSuspenseQuery(tailscaleStacksQueryOptions())
  const { stacks, unsupportedRelays } = data
  const availableStacks = React.useMemo(
    () => stacks.filter((stack) => !stack.cleanup),
    [stacks]
  )
  const relayUnsupported = unsupportedRelays.some(
    ({ id }) => id === server.relayId
  )
  const save = useStackMembershipMutation()
  const [joiningStackId, setJoiningStackId] = React.useState<string | null>(
    null
  )
  const openJoinDialog = React.useCallback((stackId: string) => {
    setJoiningStackId(stackId)
  }, [])
  const joiningStack = stacks.find(({ id }) => id === joiningStackId)

  return (
    <section className="overflow-hidden border border-border/80 bg-card/45">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Network className="size-4 shrink-0 text-primary" />
          <h2 className="truncate text-sm font-semibold">Tailscale networks</h2>
          <span className="grid size-4 shrink-0 place-items-center">
            {relayUnsupported ? (
              <TailscaleRelayUpdateHint relayName={server.relayName} />
            ) : null}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button asChild size="sm" variant="ghost">
            <Link to="/infra/tailscale">
              <Settings2 />
              Manage
            </Link>
          </Button>
        </div>
      </div>
      {availableStacks.length ? (
        <div className="divide-y divide-border/65">
          {availableStacks.map((stack) => {
            const binding = findBinding(stack, server)
            return (
              <GameServerMembershipRow
                key={stack.id}
                binding={binding}
                disabled={
                  save.isPending || (relayUnsupported && Boolean(binding))
                }
                joinDisabled={relayUnsupported}
                pending={
                  save.isPending && save.variables?.stack.id === stack.id
                }
                stack={stack}
                relayId={server.relayId}
                serverId={server.id}
                onJoin={openJoinDialog}
                onSave={save.mutateAsync}
              />
            )
          })}
        </div>
      ) : (
        <p className="px-4 py-8 text-center text-xs text-muted-foreground">
          No Tailscale networks are available.
        </p>
      )}
      {save.error ? (
        <p
          className="border-t border-destructive/25 bg-destructive/5 px-4 py-2 text-xs text-destructive"
          role="alert"
        >
          {errorMessage(save.error)}
        </p>
      ) : null}
      {joiningStack ? (
        <JoinNetworkDialog
          key={joiningStack.id}
          network={joiningStack}
          open
          pending={save.isPending}
          server={server}
          onOpenChange={(open) => {
            if (!open) setJoiningStackId(null)
          }}
          onJoin={async (hostname, authKey) => {
            await save.mutateAsync({
              authKey,
              bindings: [
                ...joiningStack.bindings,
                {
                  address: "",
                  hostname,
                  instanceId: server.id,
                  relayId: server.relayId,
                  relayName: server.relayName,
                },
              ],
              stack: joiningStack,
            })
            setJoiningStackId(null)
          }}
        />
      ) : null}
    </section>
  )
}

const MembershipToolbar = React.memo(function MembershipToolbar({
  searchStore,
  stackName,
}: {
  searchStore: WorkspaceTableSearchStore
  stackName: string
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  useWorkspaceTableSearchInput(inputRef, searchStore)

  return (
    <div className="flex min-w-0 items-center gap-2 border-b bg-background/25 p-3">
      <TailscaleMembershipSyncButton />
      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="search"
          defaultValue={searchStore.getServerSnapshot()}
          onChange={(event) => searchStore.set(event.currentTarget.value)}
          placeholder="Search servers"
          aria-label={`Search servers in ${stackName}`}
          className="pl-9 text-base md:text-sm"
        />
      </div>
      <span className="ml-auto hidden truncate px-2 text-xs font-semibold sm:block">
        {stackName}
      </span>
    </div>
  )
})

const TailscaleMembershipSyncButton = React.memo(
  function TailscaleMembershipSyncButton() {
    const queryClient = useQueryClient()
    const [syncing, setSyncing] = React.useState(false)

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label="Refresh servers"
            aria-busy={syncing}
            disabled={syncing}
            onClick={() => {
              setSyncing(true)
              forkPromise(() =>
                ensuringPromise(
                  () =>
                    Promise.all([
                      queryClient.invalidateQueries({
                        queryKey: queryKeys.tailscaleStacks,
                      }),
                      queryClient.invalidateQueries({
                        queryKey: queryKeys.relay.snapshot,
                      }),
                    ]),
                  () => setSyncing(false)
                )
              )
            }}
          >
            <RefreshCw className={syncing ? "animate-spin" : undefined} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Refresh servers</TooltipContent>
      </Tooltip>
    )
  }
)

const TailscaleMembershipTable = React.memo(function TailscaleMembershipTable({
  highlightedServerKey,
  pending,
  searchStore,
  servers,
  serversPending,
  stack,
  onSave,
}: {
  highlightedServerKey?: string
  pending: boolean
  searchStore: WorkspaceTableSearchStore
  servers: Array<TailscaleServer>
  serversPending: boolean
  stack: TailscaleStackOverview
  onSave: (bindings: Array<StackBinding>, authKey?: string) => Promise<unknown>
}) {
  const renderRow = React.useCallback(
    (server: TailscaleServer) => (
      <TailscaleMembershipRow
        highlighted={
          highlightedServerKey === tailscaleServerKey(server.relayId, server.id)
        }
        pending={pending}
        server={server}
        stack={stack}
        onSave={onSave}
      />
    ),
    [highlightedServerKey, onSave, pending, stack]
  )
  const renderEmpty = React.useCallback(
    (searchActive: boolean) => (
      <div className="grid min-h-52 place-items-center px-6 text-center text-xs text-muted-foreground">
        {serversPending
          ? "Loading servers…"
          : searchActive
            ? "No servers match your search."
            : "No servers are available."}
      </div>
    ),
    [serversPending]
  )

  return (
    <WorkspaceDataTable
      getRowKey={serverRowKey}
      getSearchText={serverSearchText}
      head={<MembershipTableHead />}
      items={servers}
      renderEmpty={renderEmpty}
      renderRow={renderRow}
      searchStore={searchStore}
    />
  )
})

const MembershipTableHead = React.memo(function MembershipTableHead() {
  return (
    <WorkspaceTableHead>
      <WorkspaceTableHeading className="w-auto sm:w-[32%]">
        Server
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[20%] sm:table-cell">
        Node
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-[44%] sm:w-[36%]">
        Hostname
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-16 text-center sm:w-24">
        Connected
      </WorkspaceTableHeading>
    </WorkspaceTableHead>
  )
})

const TailscaleMembershipRow = React.memo(function TailscaleMembershipRow({
  highlighted,
  pending,
  server,
  stack,
  onSave,
}: {
  highlighted: boolean
  pending: boolean
  server: TailscaleServer
  stack: TailscaleStackOverview
  onSave: (bindings: Array<StackBinding>, authKey?: string) => Promise<unknown>
}) {
  const binding = findBinding(stack, server)
  const initialHostname = binding?.hostname ?? defaultTailscaleHostname(server)
  const [hostname, setHostname] = React.useState(initialHostname)
  const [authOpen, setAuthOpen] = React.useState(false)
  const hostnameRef = React.useRef<HTMLInputElement>(null)
  const rowRef = React.useRef<HTMLTableRowElement>(null)
  const deploymentExists = stack.deployments.some(
    (deployment) => deployment.relayId === server.relayId
  )
  const disabled = pending || !server.tailscaleSupported
  const dirty = Boolean(binding && hostname.trim() !== binding.hostname)

  React.useEffect(() => {
    setHostname(initialHostname)
  }, [initialHostname])

  React.useEffect(() => {
    if (!highlighted) return
    rowRef.current?.scrollIntoView({ block: "center", inline: "nearest" })
    hostnameRef.current?.focus({ preventScroll: true })
    hostnameRef.current?.select()
  }, [highlighted])

  const enable = async (authKey?: string) => {
    await onSave(
      [
        ...stack.bindings,
        {
          address: "",
          hostname: hostname.trim(),
          instanceId: server.id,
          relayId: server.relayId,
          relayName: server.relayName,
        },
      ],
      authKey
    )
    setAuthOpen(false)
  }

  return (
    <>
      <tr
        ref={rowRef}
        className={
          highlighted
            ? "group bg-primary/10 outline-1 -outline-offset-1 outline-primary/40 transition-colors"
            : "group transition-colors hover:bg-accent/25"
        }
      >
        <WorkspaceTableCell>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="truncate text-xs font-semibold">{server.name}</p>
              <span className="grid size-4 shrink-0 place-items-center sm:hidden">
                {!server.tailscaleSupported ? (
                  <TailscaleRelayUpdateHint relayName={server.relayName} />
                ) : null}
              </span>
            </div>
            <p className="type-meta truncate font-mono text-muted-foreground">
              {server.shortId}
            </p>
          </div>
        </WorkspaceTableCell>
        <WorkspaceTableCell className="hidden sm:table-cell">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs text-muted-foreground">
              {server.relayName}
            </span>
            <span className="grid size-4 shrink-0 place-items-center">
              {!server.tailscaleSupported ? (
                <TailscaleRelayUpdateHint relayName={server.relayName} />
              ) : null}
            </span>
          </div>
        </WorkspaceTableCell>
        <WorkspaceTableCell>
          <div className="flex min-w-0 items-center gap-1.5">
            <Input
              ref={hostnameRef}
              value={hostname}
              disabled={disabled}
              onChange={(event) => setHostname(event.target.value)}
              aria-label={`Hostname for ${server.name}`}
              className="h-8 min-w-0 font-mono text-xs"
            />
            <span className="type-meta hidden shrink-0 font-mono text-muted-foreground lg:inline">
              .{stack.domain}
            </span>
            {dirty ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || !hostname.trim()}
                onClick={() =>
                  void onSave(
                    stack.bindings.map((candidate) =>
                      candidate.relayId === server.relayId &&
                      candidate.instanceId === server.id
                        ? { ...candidate, hostname: hostname.trim() }
                        : candidate
                    )
                  )
                }
              >
                Save
              </Button>
            ) : null}
          </div>
        </WorkspaceTableCell>
        <WorkspaceTableCell className="text-center">
          <Switch
            checked={Boolean(binding)}
            disabled={disabled || !hostname.trim()}
            aria-label={`${binding ? "Disconnect" : "Connect"} ${server.name}`}
            onCheckedChange={(checked) => {
              if (!checked) {
                void onSave(
                  stack.bindings.filter(
                    (candidate) =>
                      candidate.relayId !== server.relayId ||
                      candidate.instanceId !== server.id
                  )
                )
                return
              }
              if (deploymentExists || stack.integration) void enable()
              else setAuthOpen(true)
            }}
          />
        </WorkspaceTableCell>
      </tr>
      {authOpen ? (
        <AuthKeyDialog
          networkName={stack.name}
          open
          pending={pending}
          onOpenChange={setAuthOpen}
          onSubmit={enable}
        />
      ) : null}
    </>
  )
})

const GameServerMembershipRow = React.memo(function GameServerMembershipRow({
  binding,
  disabled,
  joinDisabled,
  pending,
  relayId,
  serverId,
  stack,
  onJoin,
  onSave,
}: {
  binding?: StackBinding
  disabled: boolean
  joinDisabled: boolean
  pending: boolean
  relayId: string
  serverId: string
  stack: TailscaleStackOverview
  onJoin: (stackId: string) => void
  onSave: ReturnType<typeof useStackMembershipMutation>["mutateAsync"]
}) {
  const highlightedServerKey = tailscaleServerKey(relayId, serverId)

  return (
    <div className="grid items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold">{stack.name}</p>
        <p className="type-meta mt-0.5 truncate font-mono text-muted-foreground">
          {binding ? binding.address : `*.${stack.domain}`}
        </p>
      </div>
      <p className="type-code min-w-0 truncate text-muted-foreground">
        {binding ? `${binding.hostname}.${stack.domain}` : "Not connected"}
      </p>
      <div className="flex items-center justify-end gap-1">
        {binding ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  asChild
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`Edit ${binding.hostname}.${stack.domain}`}
                >
                  <Link
                    to="/infra/tailscale"
                    search={{
                      member: highlightedServerKey,
                      network: stack.id,
                    }}
                  >
                    <Pencil />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Edit hostname</TooltipContent>
            </Tooltip>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() =>
                forkPromise(() =>
                  onSave({
                    bindings: stack.bindings.filter(
                      (candidate) =>
                        candidate.relayId !== relayId ||
                        candidate.instanceId !== serverId
                    ),
                    stack,
                  })
                )
              }
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <Unplug />}
              Leave
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || joinDisabled}
            onClick={() => onJoin(stack.id)}
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Network />}
            Join
          </Button>
        )}
      </div>
    </div>
  )
})

const JoinNetworkDialog = React.memo(function JoinNetworkDialog({
  network,
  open,
  pending,
  server,
  onOpenChange,
  onJoin,
}: {
  network: TailscaleStackOverview
  open: boolean
  pending: boolean
  server: InstanceWorkspaceInstance
  onOpenChange: (open: boolean) => void
  onJoin: (hostname: string, authKey?: string) => Promise<void>
}) {
  const [hostname, setHostname] = React.useState(() =>
    defaultTailscaleHostname(server)
  )
  const [authKey, setAuthKey] = React.useState("")
  const needsAuth = Boolean(
    !network.integration &&
    !network.deployments.some(
      (deployment) => deployment.relayId === server.relayId
    )
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Join {network.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Hostname</span>
            <div className="flex items-center">
              <Input
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                className="min-w-0 rounded-r-none font-mono"
              />
              <span className="flex h-9 shrink-0 items-center border border-l-0 border-input bg-muted/30 px-3 font-mono text-xs text-muted-foreground">
                .{network.domain}
              </span>
            </div>
          </label>
          {needsAuth ? (
            <label className="block">
              <span className="mb-2 flex items-center gap-1.5 text-xs font-medium">
                <KeyRound className="size-3.5" />
                Auth key for this node
              </span>
              <Input
                type="password"
                autoComplete="off"
                value={authKey}
                onChange={(event) => setAuthKey(event.target.value)}
                placeholder="tskey-auth-…"
                className="font-mono"
              />
            </label>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={
              pending || !hostname.trim() || (needsAuth && !authKey.trim())
            }
            onClick={() =>
              forkPromise(() =>
                onJoin(hostname.trim(), needsAuth ? authKey.trim() : undefined)
              )
            }
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Network />}
            Join
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

const AuthKeyDialog = React.memo(function AuthKeyDialog({
  networkName,
  open,
  pending,
  onOpenChange,
  onSubmit,
}: {
  networkName: string
  open: boolean
  pending: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (authKey: string) => Promise<unknown>
}) {
  const [authKey, setAuthKey] = React.useState("")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a node to {networkName}</DialogTitle>
        </DialogHeader>
        <label className="block py-2">
          <span className="mb-2 flex items-center gap-1.5 text-xs font-medium">
            <KeyRound className="size-3.5" />
            Auth key
          </span>
          <Input
            type="password"
            autoComplete="off"
            value={authKey}
            onChange={(event) => setAuthKey(event.target.value)}
            placeholder="tskey-auth-…"
            className="font-mono"
            autoFocus
          />
        </label>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending || !authKey.trim()}
            onClick={() => forkPromise(() => onSubmit(authKey.trim()))}
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Network />}
            Add node
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

function useStackMembershipMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      authKey,
      bindings,
      stack,
    }: {
      authKey?: string
      bindings: Array<StackBinding>
      stack: TailscaleStackOverview
    }) =>
      saveTailscaleStack({
        data: stackSaveInput(stack, bindings, authKey),
      }),
    onMutate: ({ bindings, stack }) => {
      const toast = membershipOperationToast(stack, bindings)
      showTailscaleOperationProgress(toast)
      return toast
    },
    onSuccess: async (next) => {
      queryClient.setQueryData(queryKeys.tailscaleStacks, next)
      await queryClient.invalidateQueries({
        queryKey: queryKeys.relay.snapshot,
      })
    },
    onError: (cause, _input, toast) => {
      if (toast) showTailscaleOperationError(toast, cause)
    },
    onSettled: (_data, error, _input, toast) => {
      if (!error && toast) showTailscaleOperationSuccess(toast)
    },
  })
}

function membershipOperationToast(
  stack: TailscaleStackOverview,
  bindings: Array<StackBinding>
) {
  const currentBindingKeys = new Set(stack.bindings.map(stackBindingKey))
  const nextBindingKeys = new Set(bindings.map(stackBindingKey))
  const added = bindings.some(
    (binding) => !currentBindingKeys.has(stackBindingKey(binding))
  )
  const removed = stack.bindings.some(
    (binding) => !nextBindingKeys.has(stackBindingKey(binding))
  )
  const deployedRelayIds = new Set(
    stack.deployments.map(({ relayId }) => relayId)
  )
  const newRelayIds = new Set<string>()
  for (const { relayId } of bindings) {
    if (!deployedRelayIds.has(relayId)) {
      newRelayIds.add(relayId)
    }
  }
  const operation: TailscaleOperation =
    newRelayIds.size > 0
      ? "install"
      : added
        ? "connect"
        : removed
          ? "disconnect"
          : "update"

  return {
    id: tailscaleOperationToastId(stack.id),
    networkName: stack.name,
    nodeCount: operation === "install" ? newRelayIds.size : undefined,
    operation,
  }
}

function stackBindingKey({
  instanceId,
  relayId,
}: Pick<StackBinding, "instanceId" | "relayId">): string {
  return `${relayId}:${instanceId}`
}

function stackSaveInput(
  stack: TailscaleStackOverview,
  bindings: Array<StackBinding>,
  authKey?: string,
  domain = stack.domain
): SaveStackInput {
  return {
    ...(authKey ? { authKey } : {}),
    bindings: bindings.map(({ hostname, instanceId, relayId }) => ({
      hostname,
      instanceId,
      relayId,
    })),
    domain,
    id: stack.id,
    name: stack.name,
  }
}

function normalizeTailscaleDomain(value: string): string {
  return value
    .trim()
    .replace(/^[.]+|[.]+$/gu, "")
    .toLowerCase()
}

function sameStrings(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean {
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  )
}

function tailscaleSetupVerified(
  inspection: SetupPreview["inspection"]
): boolean {
  return (
    inspection.dns.desiredResolvers.length > 0 &&
    sameStrings(
      inspection.dns.currentResolvers,
      inspection.dns.desiredResolvers
    ) &&
    inspection.routes.length > 0 &&
    inspection.routes.every((route) => route.advertised && route.approved)
  )
}

function isNetworkChangeError(cause: unknown): boolean {
  return (
    cause instanceof TypeError &&
    cause.message.toLowerCase().includes("failed to fetch")
  )
}

async function recoverTailscaleIntegrationStatus(
  stackId: string,
  originalError: unknown
) {
  // Applying split DNS briefly changes the browser's network configuration on
  // the same Mac. Chromium cancels the successful request with
  // ERR_NETWORK_CHANGED, so verify the persisted result once networking settles.
  return Effect.runPromise(
    Effect.gen(function* () {
      for (const delay of [250, 500, 1_000, 2_000, 3_000]) {
        yield* Effect.sleep(delay)
        const result = yield* Effect.tryPromise({
          try: () =>
            getTailscaleIntegrationStatus({
              data: { id: stackId },
            }),
          catch: (cause) => cause,
        }).pipe(Effect.option)
        if (
          result._tag === "Some" &&
          tailscaleSetupVerified(result.value.inspection)
        ) {
          return result.value
        }
        // The DNS transition may cancel more than one request.
      }
      return yield* Effect.fail(originalError)
    })
  )
}

function findBinding(
  stack: TailscaleStackOverview,
  server: Pick<TailscaleServer, "id" | "relayId">
) {
  return stack.bindings.find(
    (binding) =>
      binding.relayId === server.relayId && binding.instanceId === server.id
  )
}

function serverRowKey(server: TailscaleServer) {
  return tailscaleServerKey(server.relayId, server.id)
}

function serverSearchText(server: TailscaleServer) {
  return `${server.name} ${server.shortId} ${server.relayName}`
}

function CenteredNetworkState({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-background/55">
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  )
}

function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "The Tailscale network could not be updated."
}

function tailscaleSetupToastId(stackId: string) {
  return `kiln-tailscale-setup-${stackId}`
}
