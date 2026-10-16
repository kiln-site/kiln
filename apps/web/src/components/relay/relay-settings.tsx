import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  relayConnectionSettingsSchema,
  relayNameSchema,
} from "@workspace/contracts"

import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"

import {
  InfoCopyValue,
  InfoDetailRow,
  InfoDetails,
  InfoEditButton,
  InfoFact,
  InfoSection,
} from "@/components/info-page"
import {
  invalidateRelayRuntimeQueries,
  messageFrom,
  updateRelayCache,
} from "@/components/relay/relay-actions"
import { RelayVersion } from "@/components/relay/relay-version"
import { canAccessRelayPermission } from "@/lib/navigation-destinations"
import type { AccessPermission } from "@/lib/permissions"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import type { PersistedRelay } from "@/lib/relay-registry"
import type { RelayDirectoryEntry } from "@/lib/relay-route"
import { renameRelay, updateRelay } from "@/server/relays"

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

export function RelayGeneralSettings({
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
      title="Relay"
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
      {editing ? (
        <InfoFact label="Address" htmlFor="relay-hostname">
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
        </InfoFact>
      ) : null}
      <InfoFact label="ID">
        <InfoCopyValue label="Relay ID" value={relay.id} />
      </InfoFact>
      <InfoFact label="Version">
        <RelayVersion relay={relay} />
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
