import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronRight } from "lucide-react"
import {
  relayConnectionSettingsSchema,
  relayNameSchema,
  relayProxyModeSchema,
  relayProxySettingsSchema,
} from "@workspace/contracts"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"

import {
  InfoCopyValue,
  InfoDetailRow,
  InfoDetails,
  InfoEditButton,
  InfoFact,
  InfoManageAccessButton,
  InfoSection,
} from "@/components/info-page"
import { relayHostAccessQueryOptions } from "@/components/relay/relay-host-access"
import {
  invalidateRelayRuntimeQueries,
  messageFrom,
  updateRelayCache,
} from "@/components/relay/relay-actions"
import {
  proxyModeLabels,
  proxyStatusPresentation,
  useRelayLiveStatus,
} from "@/components/relay/relay-presentation"
import { RelativeTime } from "@/components/relative-time"
import { StatusIndicator } from "@/components/status-indicator"
import { canAccessRelayPermission } from "@/lib/navigation-destinations"
import type { AccessPermission } from "@/lib/permissions"
import {
  accessCapabilitiesQueryOptions,
  queryKeys,
  relayProxyQueryOptions,
} from "@/lib/query-options"
import type { PersistedRelay } from "@/lib/relay-registry"
import { relayAddress, type RelayDirectoryEntry } from "@/lib/relay-route"
import { renameRelay, updateRelay, updateRelayProxy } from "@/server/relays"

// The Relay's settings on its Info page. Each section edits in place and
// saves on its own.

export function useRelayPermission(
  relayId: string,
  permission: AccessPermission
): boolean {
  const { data = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) =>
      canAccessRelayPermission(capabilities, relayId, permission),
  })
  return data
}

export function RelayConnectionSettings({
  relay,
}: {
  relay: RelayDirectoryEntry
}) {
  const canEdit = useRelayPermission(relay.id, "relay.configure")
  const [editing, setEditing] = React.useState(false)
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (form: FormData) => saveConnection(relay, form),
    onSuccess: async (updated) => {
      setEditing(false)
      if (updated.length === 0) return
      updateRelayCache(queryClient, updated)
      showToast({
        type: "success",
        message: `${updated.at(-1)?.name ?? relay.name} updated`,
        duration: 4_000,
      })
      await invalidateRelayRuntimeQueries(queryClient)
    },
  })
  const form = editing
    ? {
        error: save.error
          ? messageFrom(save.error, "Could not update Relay")
          : null,
        onCancel: () => {
          save.reset()
          setEditing(false)
        },
        onSubmit: save.mutate,
        pending: save.isPending,
      }
    : undefined

  return (
    <InfoSection
      title="Connection"
      description="How Hearth reaches the Relay"
      action={
        canEdit ? <InfoEditButton onClick={() => setEditing(true)} /> : null
      }
      form={form}
    >
      <InfoFact label="Name" htmlFor={editing ? "relay-name" : undefined}>
        {editing ? (
          <Input
            id="relay-name"
            name="name"
            className="h-8 max-w-72"
            defaultValue={relay.name}
            maxLength={120}
            required
            autoFocus
          />
        ) : (
          <span className="truncate">{relay.name}</span>
        )}
      </InfoFact>
      <InfoFact
        label="Address"
        htmlFor={editing ? "relay-hostname" : undefined}
      >
        {editing ? (
          <>
            <Input
              id="relay-hostname"
              name="hostname"
              aria-label="Hostname"
              className="h-8 max-w-60 font-mono text-xs"
              defaultValue={relay.hostname}
              placeholder="relay.example.com"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
            <Input
              name="port"
              aria-label="Port"
              className="h-8 w-20 font-mono text-xs"
              defaultValue={String(relay.port)}
              type="number"
              min={1}
              max={65_535}
              required
            />
          </>
        ) : (
          <InfoCopyValue label="Relay address" value={relayAddress(relay)} />
        )}
      </InfoFact>
      <InfoFact label="TLS">
        <InfoDetails title="TLS" trigger={tlsLabel(relay)}>
          <p>{tlsDescription(relay)}</p>
          <InfoDetailRow
            label="Browser origin"
            value={relay.browserOrigin || "Same as address"}
          />
          <p>Set when the Relay was paired.</p>
        </InfoDetails>
      </InfoFact>
      {editing ? null : (
        <InfoFact label="Last connected">
          {relay.lastConnectedAt ? (
            <RelativeTime timestamp={Date.parse(relay.lastConnectedAt)} />
          ) : (
            "Never"
          )}
        </InfoFact>
      )}
      {relay.lastError && !editing ? (
        <InfoFact label="Last error">
          <span
            className="truncate font-mono text-xs text-muted-foreground"
            title={relay.lastError}
          >
            {relay.lastError}
          </span>
        </InfoFact>
      ) : null}
    </InfoSection>
  )
}

// Name and address live in separate stores, so the whole form is checked
// before either is saved. Unchanged values aren't sent.
async function saveConnection(
  relay: RelayDirectoryEntry,
  form: FormData
): Promise<Array<PersistedRelay>> {
  const name = relayNameSchema.safeParse(form.get("name"))
  if (!name.success) {
    throw new Error(name.error.issues[0]?.message ?? "Enter a Relay name")
  }
  const connection = relayConnectionSettingsSchema.safeParse({
    hostname: form.get("hostname"),
    port: Number(form.get("port")),
    useTls: relay.useTls,
  })
  if (!connection.success) {
    throw new Error(
      connection.error.issues[0]?.message ?? "Enter a valid address"
    )
  }
  const updated: Array<PersistedRelay> = []
  if (name.data !== relay.name) {
    updated.push(
      await renameRelay({ data: { name: name.data, relayId: relay.id } })
    )
  }
  if (
    connection.data.hostname !== relay.hostname ||
    connection.data.port !== relay.port
  ) {
    updated.push(
      await updateRelay({ data: { id: relay.id, ...connection.data } })
    )
  }
  return updated
}

export function RelayProxySettings({
  relay,
  routeId,
}: {
  relay: RelayDirectoryEntry
  routeId: string
}) {
  const { connected } = useRelayLiveStatus(relay)
  const canEdit = useRelayPermission(relay.id, "relay.configure")
  const canOpen = useRelayPermission(relay.id, "instance.network.read")
  const proxy = useQuery({
    ...relayProxyQueryOptions(relay.id),
    enabled: connected,
  })
  const [editing, setEditing] = React.useState(false)
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (form: FormData) => {
      const settings = relayProxySettingsSchema.safeParse({
        acmeEmail: proxy.data?.settings.acmeEmail,
        mode: relayProxyModeSchema.catch("none").parse(form.get("mode")),
        traefikImage: form.get("traefikImage"),
      })
      if (!settings.success) {
        throw new Error(
          settings.error.issues[0]?.message ?? "Enter valid proxy settings"
        )
      }
      return updateRelayProxy({ data: { relayId: relay.id, ...settings.data } })
    },
    onSuccess: (result) => {
      setEditing(false)
      queryClient.setQueryData(queryKeys.relayProxy(relay.id), result)
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: queryKeys.relayProxyConfiguration(relay.id),
      })
      showToast({ type: "success", message: "Proxy updated", duration: 4_000 })
    },
  })
  const settings = proxy.data?.settings
  const form =
    editing && settings
      ? {
          error: save.error
            ? messageFrom(save.error, "Could not update the proxy")
            : null,
          onCancel: () => {
            save.reset()
            setEditing(false)
          },
          onSubmit: save.mutate,
          pending: save.isPending,
        }
      : undefined

  return (
    <InfoSection
      title="Proxy"
      description="Routes web domains to apps"
      action={
        <>
          {proxy.data ? (
            <StatusIndicator
              status={proxyStatusPresentation(proxy.data.diagnostics)}
            />
          ) : null}
          {canOpen ? (
            <Button asChild size="sm" variant="ghost">
              <Link to="/relay/$relayId/proxy" params={{ relayId: routeId }}>
                Routes
                <ChevronRight />
              </Link>
            </Button>
          ) : null}
          {canEdit && settings ? (
            <InfoEditButton onClick={() => setEditing(true)} />
          ) : null}
        </>
      }
      form={form}
    >
      {settings ? (
        <>
          <InfoFact
            label="Mode"
            htmlFor={form ? "relay-proxy-mode" : undefined}
          >
            {form ? (
              <Select name="mode" defaultValue={settings.mode}>
                <SelectTrigger
                  id="relay-proxy-mode"
                  className="type-control-sm h-8 w-full max-w-60"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {relayProxyModeSchema.options.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {proxyModeLabels[mode]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              proxyModeLabels[settings.mode]
            )}
          </InfoFact>
          <InfoFact
            label="Traefik image"
            htmlFor={form ? "relay-traefik-image" : undefined}
          >
            {form ? (
              <Input
                id="relay-traefik-image"
                name="traefikImage"
                className="h-8 max-w-60 font-mono text-xs"
                defaultValue={settings.traefikImage}
                placeholder="traefik:v3.6"
                required
              />
            ) : (
              <span className="truncate font-mono text-xs">
                {settings.traefikImage}
              </span>
            )}
          </InfoFact>
        </>
      ) : (
        <p className="py-3 text-[0.8125rem] text-muted-foreground">
          {!relay.enabled
            ? "Resume this Relay to see its proxy."
            : proxy.error
              ? messageFrom(proxy.error, "Could not read the proxy settings.")
              : connected
                ? "Reading the proxy settings…"
                : "The proxy appears once Hearth reaches the Relay."}
        </p>
      )}
    </InfoSection>
  )
}

export function RelayAccessSettings({ relay }: { relay: RelayDirectoryEntry }) {
  return (
    <InfoSection
      title="Access"
      description="What Hearth can do on this Relay"
      action={
        <InfoManageAccessButton
          relayId={relay.id}
          resourceId={relay.id}
          resourceType="relay"
        />
      }
    >
      <InfoFact label="Hearth access">
        <InfoDetails
          title={roleLabel(relay.role)}
          trigger={roleLabel(relay.role)}
        >
          <p>{roleDescription(relay)}</p>
          <p>Set when the Relay was paired.</p>
        </InfoDetails>
      </InfoFact>
      <InfoFact label="Host access">
        <RelayHostAccessValue relay={relay} />
      </InfoFact>
    </InfoSection>
  )
}

function RelayHostAccessValue({ relay }: { relay: RelayDirectoryEntry }) {
  const { connected } = useRelayLiveStatus(relay)
  const { data: access } = useQuery({
    ...relayHostAccessQueryOptions(relay.id),
    enabled: connected,
  })
  if (!access) return <span className="text-muted-foreground">—</span>
  const files = access.files.status !== "disabled"
  const label =
    access.terminal && files
      ? "Terminal and files"
      : access.terminal
        ? "Terminal only"
        : files
          ? "Files only"
          : "Off"
  return (
    <InfoDetails title="Host access" trigger={label}>
      <p>
        Whether this Relay’s Terminal and Files reach the machine itself, not
        just its game servers, apps, and databases.
      </p>
      <p>Set in the Relay’s config on the node.</p>
    </InfoDetails>
  )
}

function tlsLabel(relay: RelayDirectoryEntry): string {
  if (!relay.useTls) return "Off"
  return relay.managedTls ? "Managed by the Relay" : "Custom certificate"
}

function tlsDescription(relay: RelayDirectoryEntry): string {
  if (!relay.useTls) {
    return "Traffic between Hearth and this Relay is not encrypted."
  }
  return relay.managedTls
    ? "The Relay issues its own certificate. Hearth trusts it through the certificate authority saved when the Relay was paired."
    : "The Relay serves a certificate from a public or custom certificate authority."
}

function roleLabel(role: RelayDirectoryEntry["role"]): string {
  if (role === "full_access") return "Full access"
  if (role === "read_only") return "Read only"
  return "Custom"
}

function roleDescription(relay: RelayDirectoryEntry): string {
  if (relay.role === "full_access") {
    return "Hearth can use every Relay action: create and remove game servers, open terminals, edit files, and change settings."
  }
  if (relay.role === "read_only") {
    return "Hearth can see this Relay and what runs on it, but can’t change anything."
  }
  return `Hearth can use ${relay.actions.length} selected Relay ${relay.actions.length === 1 ? "action" : "actions"}.`
}
