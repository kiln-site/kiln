import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Effect } from "effect"
import {
  Activity,
  ArrowRight,
  Box,
  Check,
  Copy,
  Cpu,
  FileCode2,
  Fingerprint,
  Globe2,
  HardDrive,
  LoaderCircle,
  Network,
  Save,
  Server,
  Tags,
  Trash2,
  TriangleAlert,
  Users,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"
import { MAXIMUM_INSTANCE_NAME_LENGTH } from "@workspace/contracts"

import { ResourceAccessPanel } from "@/components/access-page"
import { ReadOnlyCodeViewer } from "@/components/read-only-code-viewer"
import { ServerDeleteDialog } from "@/components/server-delete-dialog"
import { hostPortAddress } from "@/lib/domain-address"
import { provisioningFailureDiagnostics } from "@/lib/provisioning-diagnostics"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"
import { instanceRecipeQueryOptions } from "@/lib/query-options"
import { applyUpdatedInstance } from "@/lib/realtime-client"
import type {
  InstanceSettingsInstance,
  RelayNodeSummary,
} from "@/lib/relay-selectors"
import { updateInstanceName, uploadToMclogs } from "@/server/relay"

export function SettingsWorkspace({
  instance,
  node,
  permissions,
  onDeleted,
  passwordRequired,
  relayConnected,
}: {
  instance: InstanceSettingsInstance
  node: RelayNodeSummary
  permissions: {
    deleteServer: boolean
    networkRead: boolean
    configurationRead: boolean
    configurationWrite: boolean
    shareLogs: boolean
  }
  onDeleted: () => Promise<void> | void
  passwordRequired: boolean
  relayConnected: boolean
}) {
  const {
    deleteServer: canDelete,
    networkRead: canViewNetwork,
    configurationWrite: canRename,
    shareLogs: canShare,
  } = permissions
  const canViewStartup = permissions.configurationRead
  const rawAddress =
    instance.publicHost && instance.publicPort
      ? hostPortAddress(instance.publicHost, instance.publicPort)
      : instance.connectAddress
  const configuredAddress =
    instance.connectAddress !== rawAddress ? instance.connectAddress : null

  if (instance.provisioning) {
    return (
      <ProvisioningInfoWorkspace
        instance={instance}
        node={node}
        canDelete={canDelete}
        onDeleted={onDeleted}
        passwordRequired={passwordRequired}
        relayConnected={relayConnected}
      />
    )
  }

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
        <div className="grid items-stretch gap-4 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
            <InfoCard>
              <InfoCardHeader
                icon={<Fingerprint />}
                title="Identity"
                action={
                  <Badge
                    variant="outline"
                    className={cn(
                      "type-meta font-mono",
                      instance.game.toLowerCase() === "minecraft" &&
                        "border-emerald-500/35 bg-emerald-500/12 text-emerald-300"
                    )}
                  >
                    {instance.game}
                  </Badge>
                }
              />
              <InstanceNameForm
                instance={instance}
                canRename={canRename && relayConnected}
              />
              <MetaRow
                icon={Fingerprint}
                label="Server full ID"
                value={instance.id}
                mono
                wrap
              />
            </InfoCard>

            <InfoCard>
              <InfoCardHeader
                icon={<Globe2 />}
                title="Connection info"
                action={
                  canViewNetwork ? (
                    <Button asChild size="sm" variant="ghost">
                      <Link
                        to="/server/$serverId/network"
                        params={{ serverId: instance.routeId }}
                      >
                        Network
                        <ArrowRight />
                      </Link>
                    </Button>
                  ) : null
                }
              />
              <CopyMetaRow label="Raw connection URL" value={rawAddress} />
              <CopyMetaRow
                label="Configured URL"
                value={configuredAddress ?? "Not configured"}
                copyable={configuredAddress !== null}
              />
            </InfoCard>

            <BrickInfoCard
              canShare={canShare}
              canViewStartup={canViewStartup}
              instance={instance}
            />
          </div>

          <InstanceUsersCard instance={instance} />
        </div>

        <InfoCard className="mt-4">
          <InfoCardHeader
            icon={<Network />}
            title="Relay placement"
            action={
              <span
                className={`type-meta flex items-center gap-1.5 font-mono ${relayConnected ? "text-emerald-400" : "text-amber-300"}`}
              >
                <span
                  className={`size-1.5 rounded-full ${relayConnected ? "bg-emerald-400" : "bg-amber-300"}`}
                />
                {relayConnected ? "CONNECTED" : "LAST KNOWN"}
              </span>
            }
          />
          <div className="grid sm:grid-cols-2 lg:grid-cols-4">
            <MetaRow
              icon={HardDrive}
              label="Node"
              value={`${node.name} · ${node.id}`}
            />
            <MetaRow
              icon={Box}
              label="Container"
              value={instance.containerId ?? "Not created"}
              mono
            />
            <MetaRow
              icon={Tags}
              label="Compose service"
              value={instance.service}
              mono
            />
            <MetaRow
              icon={HardDrive}
              label="Data directory"
              value={instance.directory}
              mono
            />
          </div>
        </InfoCard>

        {canDelete ? (
          <ServerDangerZone
            instance={instance}
            onDeleted={onDeleted}
            passwordRequired={passwordRequired}
            relayConnected={relayConnected}
          />
        ) : null}
      </div>
    </section>
  )
}

function ProvisioningInfoWorkspace({
  instance,
  node,
  canDelete,
  onDeleted,
  passwordRequired,
  relayConnected,
}: {
  instance: InstanceSettingsInstance
  node: RelayNodeSummary
  canDelete: boolean
  onDeleted: () => Promise<void> | void
  passwordRequired: boolean
  relayConnected: boolean
}) {
  const provisioning = instance.provisioning
  if (!provisioning) return null
  const failed = provisioning.phase === "failed"
  const failureDiagnostics = provisioningFailureDiagnostics({
    attempt: provisioning.attempt,
    error: provisioning.error,
    failedPhase: provisioning.failedPhase,
    instanceId: instance.id,
    instanceName: instance.name,
    relayId: instance.relayId,
  })

  function copyDiagnostics() {
    Effect.runFork(
      Effect.tryPromise({
        try: () => navigator.clipboard.writeText(failureDiagnostics),
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: () =>
            showToast({
              message:
                "Could not copy diagnostics. Select the error text manually.",
              type: "error",
            }),
          onSuccess: () =>
            showToast({
              message: "Provisioning diagnostics copied",
              type: "success",
            }),
        })
      )
    )
  }

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <InfoCard>
            <InfoCardHeader
              icon={<Fingerprint />}
              title="Attempted server identity"
              action={
                <Badge
                  variant="outline"
                  className={cn(
                    "type-meta font-mono",
                    failed
                      ? "border-destructive/35 bg-destructive/10 text-destructive"
                      : "border-amber-500/35 bg-amber-500/10 text-amber-300"
                  )}
                >
                  {failed ? "FAILED" : "PROVISIONING"}
                </Badge>
              }
            />
            <MetaRow icon={Server} label="Name" value={instance.name} />
            <MetaRow
              icon={Fingerprint}
              label="Server full ID"
              value={instance.id}
              mono
              wrap
            />
            <MetaRow
              icon={Box}
              label="Brick"
              value={`${instance.implementation} · ${instance.version}`}
            />
          </InfoCard>

          <InfoCard>
            <InfoCardHeader
              icon={failed ? <TriangleAlert /> : <LoaderCircle />}
              title="Provisioning attempt"
            />
            <MetaRow
              icon={Activity}
              label="Attempt"
              value={String(Math.max(1, provisioning.attempt))}
            />
            <MetaRow
              icon={Tags}
              label="Phase"
              value={formatProvisioningPhase(
                provisioning.failedPhase ?? provisioning.phase
              )}
              mono
            />
            {failed ? (
              <div className="flex min-h-14 items-start gap-3 border-b px-4 py-3 last:border-b-0">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <span className="type-technical-label block text-muted-foreground">
                    Failure
                  </span>
                  <Button
                    className="mt-2"
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={copyDiagnostics}
                  >
                    <Copy />
                    Copy diagnostics
                  </Button>
                </div>
              </div>
            ) : (
              <MetaRow
                icon={Activity}
                label="Status"
                value="The Relay is still building this server."
                wrap
              />
            )}
          </InfoCard>
        </div>

        <InfoCard className="mt-4">
          <InfoCardHeader
            icon={<Network />}
            title="Retained placement data"
            action={
              <span
                className={`type-meta flex items-center gap-1.5 font-mono ${relayConnected ? "text-emerald-400" : "text-amber-300"}`}
              >
                <span
                  className={`size-1.5 rounded-full ${relayConnected ? "bg-emerald-400" : "bg-amber-300"}`}
                />
                {relayConnected ? "CONNECTED" : "LAST KNOWN"}
              </span>
            }
          />
          <div className="grid sm:grid-cols-2 lg:grid-cols-4">
            <MetaRow
              icon={HardDrive}
              label="Node"
              value={`${node.name} · ${node.id}`}
            />
            <MetaRow
              icon={Box}
              label="Container"
              value={instance.containerId ?? "Not created"}
              mono
            />
            <MetaRow
              icon={Tags}
              label="Compose service"
              value={instance.service}
              mono
            />
            <MetaRow
              icon={HardDrive}
              label="Data directory"
              value={instance.directory}
              mono
            />
          </div>
        </InfoCard>

        {canDelete ? (
          <ServerDangerZone
            instance={instance}
            onDeleted={onDeleted}
            passwordRequired={passwordRequired}
            relayConnected={relayConnected}
          />
        ) : null}
      </div>
    </section>
  )
}

function formatProvisioningPhase(phase: string): string {
  const words = phase.replaceAll("_", " ")
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

function InfoCard({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border bg-background/45",
        className
      )}
    >
      {children}
    </div>
  )
}

function InfoCardHeader({
  action,
  icon,
  title,
}: {
  action?: React.ReactNode
  icon: React.ReactNode
  title: string
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2.5">
      <div className="flex items-center gap-2 text-primary [&_svg]:size-4">
        {icon}
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      {action}
    </div>
  )
}

function CopyMetaRow({
  copyable = true,
  label,
  value,
}: {
  copyable?: boolean
  label: string
  value: string
}) {
  const [copied, setCopied] = React.useState(false)
  const resetTimer = React.useRef<number | null>(null)

  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    },
    []
  )

  async function copyValue() {
    if (!copyable) return
    await navigator.clipboard.writeText(value)
    setCopied(true)
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="flex min-h-16 items-center gap-3 border-b px-4 py-3 last:border-b-0">
      <Globe2 className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="type-technical-label block text-muted-foreground">
          {label}
        </span>
        <span
          className={`mt-0.5 block truncate font-mono text-xs ${copyable ? "text-foreground" : "text-muted-foreground"}`}
          title={value}
        >
          {value}
        </span>
      </span>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        disabled={!copyable}
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() => void copyValue()}
      >
        {copied ? <Check className="text-emerald-400" /> : <Copy />}
      </Button>
    </div>
  )
}

function BrickInfoCard({
  canShare,
  canViewStartup,
  instance,
}: {
  canShare: boolean
  canViewStartup: boolean
  instance: InstanceSettingsInstance
}) {
  const [recipeOpen, setRecipeOpen] = React.useState(false)
  const recipeQuery = useQuery({
    ...instanceRecipeQueryOptions(instance.relayId, instance.id),
    enabled: recipeOpen,
  })
  const shareRecipe = React.useCallback(
    async (content: string) => {
      const result = await uploadToMclogs({
        data: {
          content,
          implementation: instance.implementation,
          instanceId: instance.id,
          path: "brick-recipe.json",
          relayId: instance.relayId,
          version: instance.version,
        },
      })
      return result.url
    },
    [instance.id, instance.implementation, instance.relayId, instance.version]
  )

  return (
    <>
      <InfoCard>
        <InfoCardHeader
          icon={<Box />}
          title="Brick info"
          action={
            canViewStartup ? (
              <Button asChild size="sm" variant="ghost">
                <Link
                  to="/server/$serverId/startup"
                  params={{ serverId: instance.routeId }}
                >
                  Startup
                  <ArrowRight />
                </Link>
              </Button>
            ) : null
          }
        />
        <MetaRow
          icon={Box}
          label="Brick"
          value={instance.brickId ?? instance.implementation}
          mono
          action={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                warmSyntaxCodeEditorModule()
                setRecipeOpen(true)
              }}
            >
              <FileCode2 />
              Recipe
            </Button>
          }
        />
        <div className="grid grid-cols-2 divide-x">
          <MetaRow
            icon={Tags}
            label="Game version"
            value={`${instance.game} · ${instance.version}`}
            className="border-b-0"
          />
          <MetaRow
            icon={Cpu}
            label="Runtime"
            value={instance.javaVersion}
            mono
            className="border-b-0"
          />
        </div>
      </InfoCard>

      <Dialog open={recipeOpen} onOpenChange={setRecipeOpen}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-4xl">
          <DialogHeader className="sr-only">
            <DialogTitle>
              {recipeQuery.data?.name ?? "Brick recipe"}
            </DialogTitle>
            <DialogDescription>
              Preview this server&apos;s recipe.
            </DialogDescription>
          </DialogHeader>
          {recipeQuery.isPending ? (
            <div className="grid h-[min(72dvh,42rem)] min-h-80 place-items-center bg-card text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
            </div>
          ) : recipeQuery.isError ? (
            <div className="grid h-[min(72dvh,42rem)] min-h-80 place-items-center bg-card px-6 text-center text-xs text-destructive">
              {recipeQuery.error.message || "Could not load the Brick recipe"}
            </div>
          ) : recipeQuery.data ? (
            <ReadOnlyCodeViewer
              content={recipeQuery.data.content}
              languagePath="brick-recipe.json"
              onShare={canShare ? shareRecipe : undefined}
              sourceUrl={recipeQuery.data.sourceUrl}
              title={recipeQuery.data.name}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}

function InstanceUsersCard({
  instance,
}: {
  instance: InstanceSettingsInstance
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <InfoCard>
      <InfoCardHeader
        icon={<Users />}
        title="Users & access"
        action={
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Manage access
          </Button>
        }
      />
      <p className="p-4 text-sm text-muted-foreground">
        View invitations, assigned presets, and permissions for this server.
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>{instance.name} access</DialogTitle>
            <DialogDescription>
              Permissions and presets apply to this server. Relay assignments
              are inherited.
            </DialogDescription>
          </DialogHeader>
          {open ? (
            <ResourceAccessPanel
              scope={{
                relayId: instance.relayId,
                resourceType: "instance",
                resourceId: instance.id,
                name: instance.name,
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </InfoCard>
  )
}

function ServerDangerZone({
  instance,
  onDeleted,
  passwordRequired,
  relayConnected,
}: {
  instance: InstanceSettingsInstance
  onDeleted: () => Promise<void> | void
  passwordRequired: boolean
  relayConnected: boolean
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <div className="mt-4 flex flex-col gap-3 rounded-xl border border-destructive/25 bg-destructive/4 px-4 py-3.5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-destructive/20 bg-destructive/10 text-destructive">
            <TriangleAlert className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="type-technical-label text-destructive">Danger zone</p>
            <h3 className="mt-1 text-sm font-semibold">Delete this server</h3>
            <p className="type-meta mt-1 font-mono break-all text-muted-foreground">
              {instance.id}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="destructive"
          className="shrink-0"
          disabled={!relayConnected}
          title={
            relayConnected
              ? undefined
              : "Reconnect this server's Relay before deleting"
          }
          onClick={() => setOpen(true)}
        >
          <Trash2 />
          Delete server
        </Button>
      </div>
      {open ? (
        <ServerDeleteDialog
          open
          target={{
            backupAvailable: !instance.provisioning,
            id: instance.id,
            name: instance.name,
            relayId: instance.relayId,
          }}
          onDeleted={onDeleted}
          passwordRequired={passwordRequired}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
}

function InstanceNameForm({
  instance,
  canRename,
}: {
  instance: InstanceSettingsInstance
  canRename: boolean
}) {
  const queryClient = useQueryClient()
  const updateNameMutation = useMutation({
    mutationFn: updateInstanceName,
    onSuccess: (updated) => {
      applyUpdatedInstance(queryClient, updated)
    },
  })
  const [draftName, setDraftName] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const name = draftName ?? instance.name

  async function saveName(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextName = name.trim()
    if (!nextName || nextName === instance.name || pending) return
    setPending(true)
    setSaved(false)
    setError(null)
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          updateNameMutation.mutateAsync({
            data: {
              instanceId: instance.id,
              relayId: instance.relayId,
              name: nextName,
            },
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            setDraftName(null)
            setSaved(true)
            window.setTimeout(() => setSaved(false), 1800)
          })
        ),
        Effect.catch((cause) =>
          Effect.sync(() =>
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not save instance name"
            )
          )
        ),
        Effect.ensuring(Effect.sync(() => setPending(false)))
      )
    )
  }

  return (
    <form
      className="border-b px-4 py-3"
      onSubmit={(event) => void saveName(event)}
    >
      <div className="flex items-center gap-2">
        <Server className="size-3.5 shrink-0 text-muted-foreground" />
        <label
          htmlFor="instance-display-name"
          className="type-technical-label text-muted-foreground"
        >
          Display name
        </label>
      </div>
      <div className="mt-2 flex gap-2">
        <Input
          id="instance-display-name"
          value={name}
          onChange={(event) => {
            setDraftName(event.target.value)
            setSaved(false)
            setError(null)
          }}
          maxLength={MAXIMUM_INSTANCE_NAME_LENGTH}
          disabled={!canRename || pending}
          aria-invalid={Boolean(error)}
          className="h-9 min-w-0 flex-1"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          className="h-9 shrink-0"
          disabled={
            !canRename ||
            pending ||
            !name.trim() ||
            name.trim() === instance.name
          }
        >
          {pending ? (
            <LoaderCircle className="animate-spin" />
          ) : saved ? (
            <Check />
          ) : (
            <Save />
          )}
          {pending ? "Saving" : saved ? "Saved" : "Save"}
        </Button>
      </div>
      <p
        className={`type-meta mt-1.5 ${error ? "text-destructive" : "text-muted-foreground"}`}
      >
        {error ??
          (canRename
            ? "The display name can change without changing the server ID."
            : "You do not have permission to rename this server.")}
      </p>
    </form>
  )
}

function MetaRow({
  action,
  className,
  icon: Icon,
  label,
  value,
  mono = false,
  wrap = false,
}: {
  action?: React.ReactNode
  className?: string
  icon: typeof Server
  label: string
  value: string
  mono?: boolean
  wrap?: boolean
}) {
  return (
    <div
      className={cn(
        "flex min-h-14 items-center gap-3 border-b px-4 py-3 last:border-b-0",
        className
      )}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="type-technical-label block text-muted-foreground">
          {label}
        </span>
        <span
          className={`mt-0.5 block text-xs ${mono ? "font-mono" : "font-medium"} ${wrap ? "break-all" : "truncate"}`}
          title={value}
        >
          {value}
        </span>
      </span>
      {action}
    </div>
  )
}
