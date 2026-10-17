import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Effect } from "effect"
import {
  Cable,
  Copy,
  FileCode2,
  LoaderCircle,
  Server,
  ToyBrick,
  TriangleAlert,
} from "lucide-react"
import { MAXIMUM_INSTANCE_NAME_LENGTH } from "@workspace/contracts"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"

import { CodeDocumentPanel } from "@/components/code-document-panel"
import {
  InfoCopyValue,
  InfoFact,
  InfoSection,
  InfoSectionLink,
} from "@/components/info-page"
import { InstanceFavoriteButton } from "@/components/instance-favorite"
import { LiveServerBrickIcon } from "@/components/server-brick-icon"
import { RenameButton } from "@/components/rename-dialog"
import { StatusIndicator } from "@/components/status-indicator"
import { hostPortAddress } from "@/lib/domain-address"
import { provisioningFailureDiagnostics } from "@/lib/provisioning-diagnostics"
import { instanceRecipeQueryOptions } from "@/lib/query-options"
import { applyUpdatedInstance } from "@/lib/realtime-client"
import type { InstanceSettingsInstance } from "@/lib/relay-selectors"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"
import { updateInstanceName, uploadToMclogs } from "@/server/relay"

// The game server's details on its Info page, one section per concern, each
// with the actions that change it.

export function ServerGeneralSettings({
  canRename,
  instance,
  relayConnected,
}: {
  canRename: boolean
  instance: InstanceSettingsInstance
  relayConnected: boolean
}) {
  return (
    <InfoSection
      icon={<Server />}
      title="Server"
      action={
        <>
          {canRename ? (
            <ServerRenameButton
              instance={instance}
              relayConnected={relayConnected}
            />
          ) : null}
          <InstanceFavoriteButton
            id={instance.id}
            kind="server"
            relayId={instance.relayId}
          />
        </>
      }
    >
      <InfoFact label="Name">
        <InfoCopyValue label="server name" mono={false} value={instance.name} />
      </InfoFact>
      <InfoFact label="Kiln ID">
        <InfoCopyValue label="server ID" value={instance.id} />
      </InfoFact>
      <InfoFact label="Game">{instance.game}</InfoFact>
    </InfoSection>
  )
}

// How players reach the server. Network changes the ports and domains.
export function ServerConnectionSettings({
  canViewNetwork,
  instance,
}: {
  canViewNetwork: boolean
  instance: InstanceSettingsInstance
}) {
  // The raw address is the Relay's host and the game port; a configured one,
  // such as a domain, is what the Relay advertises instead.
  const rawAddress =
    instance.publicHost && instance.publicPort
      ? hostPortAddress(instance.publicHost, instance.publicPort)
      : instance.connectAddress
  const configuredAddress =
    instance.connectAddress !== rawAddress ? instance.connectAddress : null

  return (
    <InfoSection
      icon={<Cable />}
      title="Connection"
      action={
        canViewNetwork ? (
          <InfoSectionLink
            to="/server/$serverId/network"
            params={{ serverId: instance.routeId }}
          >
            Network
          </InfoSectionLink>
        ) : null
      }
    >
      <InfoFact label="Configured address">
        {configuredAddress ? (
          <AddressValue label="configured address" value={configuredAddress} />
        ) : (
          <span className="text-muted-foreground">Not configured</span>
        )}
      </InfoFact>
      <InfoFact label="Raw connect address">
        <AddressValue label="raw connect address" value={rawAddress} />
      </InfoFact>
      {/* A count only; the Network page lists them. */}
      {instance.ports.length > 0 ? (
        <InfoFact label="Ports">
          {instance.ports.length === 1
            ? "1 port"
            : `${instance.ports.length} ports`}
        </InfoFact>
      ) : null}
    </InfoSection>
  )
}

// The Relay reports an address it can't work out as "Error: …".
function AddressValue({ label, value }: { label: string; value: string }) {
  if (!value.startsWith("Error:")) {
    return <InfoCopyValue label={label} value={value} />
  }
  return (
    <span className="truncate font-mono text-xs text-destructive" title={value}>
      {value}
    </span>
  )
}

// What the server is built from. Startup changes its version and runtime.
export function ServerBrickSettings({
  canShare,
  canViewStartup,
  instance,
}: {
  canShare: boolean
  canViewStartup: boolean
  instance: InstanceSettingsInstance
}) {
  const provisioning = Boolean(instance.provisioning)
  return (
    <InfoSection
      icon={<ToyBrick />}
      title="Brick"
      action={
        provisioning ? null : (
          <>
            <BrickRecipeButton canShare={canShare} instance={instance} />
            {canViewStartup ? (
              <InfoSectionLink
                to="/server/$serverId/startup"
                params={{ serverId: instance.routeId }}
              >
                Startup
              </InfoSectionLink>
            ) : null}
          </>
        )
      }
    >
      <InfoFact label="Brick">
        <LiveServerBrickIcon
          brickId={instance.brickId}
          brickSource={instance.brickSource}
          className="size-4 shrink-0"
          implementation={instance.implementation}
        />
        <InfoCopyValue
          label="Brick ID"
          value={instance.brickId ?? instance.implementation}
        />
      </InfoFact>
      <InfoFact label="Version">
        <span className="truncate">
          {instance.implementation} {instance.version}
        </span>
      </InfoFact>
      <InfoFact label="Runtime">
        <span className="truncate font-mono text-xs">
          {instance.javaVersion}
        </span>
      </InfoFact>
    </InfoSection>
  )
}

// Where provisioning is, and for a failed attempt, what to copy for support.
export function ServerProvisioningSection({
  instance,
}: {
  instance: InstanceSettingsInstance
}) {
  const provisioning = instance.provisioning
  if (!provisioning) return null
  const failed = provisioning.phase === "failed"
  return (
    <InfoSection
      icon={failed ? <TriangleAlert /> : <LoaderCircle className="animate-spin" />}
      title="Provisioning"
      status={
        <StatusIndicator
          status={
            failed
              ? { label: "Failed", tone: "danger" }
              : { label: "In progress", pulse: true, tone: "info" }
          }
        />
      }
      action={failed ? <CopyDiagnosticsButton instance={instance} /> : null}
    >
      <InfoFact label="Attempt">{Math.max(1, provisioning.attempt)}</InfoFact>
      <InfoFact label="Phase">
        {provisioningPhaseLabel(provisioning.failedPhase ?? provisioning.phase)}
      </InfoFact>
      {failed ? (
        <InfoFact label="Error">
          <span
            className="truncate font-mono text-xs text-muted-foreground"
            title={provisioning.error ?? undefined}
          >
            {provisioning.error ?? "The Relay gave no reason."}
          </span>
        </InfoFact>
      ) : null}
    </InfoSection>
  )
}

function CopyDiagnosticsButton({
  instance,
}: {
  instance: InstanceSettingsInstance
}) {
  const provisioning = instance.provisioning
  if (!provisioning) return null
  const diagnostics = provisioningFailureDiagnostics({
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
        try: () => navigator.clipboard.writeText(diagnostics),
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
    <Button type="button" size="sm" variant="outline" onClick={copyDiagnostics}>
      <Copy />
      Copy diagnostics
    </Button>
  )
}

function BrickRecipeButton({
  canShare,
  instance,
}: {
  canShare: boolean
  instance: InstanceSettingsInstance
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onPointerEnter={warmSyntaxCodeEditorModule}
        onFocus={warmSyntaxCodeEditorModule}
        onClick={() => {
          warmSyntaxCodeEditorModule()
          setOpen(true)
        }}
      >
        <FileCode2 />
        Recipe
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-4xl">
          {open ? (
            <BrickRecipeDialogBody canShare={canShare} instance={instance} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}

// Fetched only while the dialog is open.
function BrickRecipeDialogBody({
  canShare,
  instance,
}: {
  canShare: boolean
  instance: InstanceSettingsInstance
}) {
  const recipeQuery = useQuery(
    instanceRecipeQueryOptions(instance.relayId, instance.id)
  )
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
      <DialogHeader className="sr-only">
        <DialogTitle>{recipeQuery.data?.name ?? "Brick recipe"}</DialogTitle>
        <DialogDescription>Preview this server&apos;s recipe.</DialogDescription>
      </DialogHeader>
      {recipeQuery.isPending ? (
        <div className="grid h-[min(72dvh,42rem)] min-h-80 place-items-center bg-card text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
        </div>
      ) : recipeQuery.isError ? (
        <div className="grid h-[min(72dvh,42rem)] min-h-80 place-items-center bg-card px-6 text-center text-xs text-destructive">
          {recipeQuery.error.message || "Could not load the Brick recipe"}
        </div>
      ) : (
        <CodeDocumentPanel
          content={recipeQuery.data.content}
          languagePath="brick-recipe.json"
          noun="recipe"
          onShare={canShare ? shareRecipe : undefined}
          sourceUrl={recipeQuery.data.sourceUrl}
          title={recipeQuery.data.name}
        />
      )}
    </>
  )
}

function ServerRenameButton({
  instance,
  relayConnected,
}: {
  instance: InstanceSettingsInstance
  relayConnected: boolean
}) {
  const queryClient = useQueryClient()
  const rename = React.useCallback(
    async (name: string) => {
      const updated = await updateInstanceName({
        data: { instanceId: instance.id, name, relayId: instance.relayId },
      })
      applyUpdatedInstance(queryClient, updated)
    },
    [instance.id, instance.relayId, queryClient]
  )
  return (
    <RenameButton
      disabledReason={
        relayConnected
          ? undefined
          : "Reconnect this server's Relay before renaming"
      }
      id={instance.id}
      maxLength={MAXIMUM_INSTANCE_NAME_LENGTH}
      name={instance.name}
      noun="server"
      rename={rename}
    />
  )
}

function provisioningPhaseLabel(phase: string): string {
  const words = phase.replaceAll("_", " ")
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}
