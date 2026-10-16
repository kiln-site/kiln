import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { TriangleAlert } from "lucide-react"
import {
  relayProxyModeSchema,
  relayProxySettingsSchema,
  type RelayProxyDiagnostics,
} from "@workspace/contracts"

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
  InfoDetailRow,
  InfoDetails,
  InfoEditButton,
  InfoFact,
  InfoSection,
} from "@/components/info-page"
import { messageFrom } from "@/components/relay/relay-actions"
import {
  proxyModeLabels,
  proxyStatusPresentation,
  useRelayLiveStatus,
} from "@/components/relay/relay-presentation"
import { useRelayPermission } from "@/components/relay/relay-settings"
import { StatusIndicator } from "@/components/status-indicator"
import { queryKeys, relayProxyQueryOptions } from "@/lib/query-options"
import type { RelayDirectoryEntry } from "@/lib/relay-route"
import { updateRelayProxy } from "@/server/relays"

// How the Relay publishes web domains: its proxy's settings, edited in place,
// and whether the proxy is healthy. The bundled Traefik's details only show
// in that mode.
export function RelayProxySettings({ relay }: { relay: RelayDirectoryEntry }) {
  const { connected } = useRelayLiveStatus(relay)
  const canEdit = useRelayPermission(relay.id, "relay.configure")
  const proxy = useQuery({
    ...relayProxyQueryOptions(relay.id),
    enabled: connected,
  })
  const [editing, setEditing] = React.useState(false)
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (form: FormData) => {
      const settings = relayProxySettingsSchema.safeParse({
        acmeEmail: String(form.get("acmeEmail") ?? "").trim() || null,
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
      showToast({ type: "success", message: "Proxy updated", duration: 4_000 })
    },
  })
  const settings = proxy.data?.settings
  const diagnostics = proxy.data?.diagnostics
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

  if (!settings || !diagnostics) {
    return (
      <InfoSection title="Proxy">
        <p className="py-3 text-[0.8125rem] text-muted-foreground">
          {!relay.enabled
            ? "Resume this Relay to see its proxy."
            : proxy.error
              ? messageFrom(proxy.error, "Could not read the proxy settings.")
              : connected
                ? "Reading the proxy settings…"
                : "The proxy appears once Hearth reaches the Relay."}
        </p>
      </InfoSection>
    )
  }

  const bundled = settings.mode === "traefik"
  return (
    <InfoSection
      title="Proxy"
      action={
        <>
          <StatusIndicator status={proxyStatusPresentation(diagnostics)} />
          {canEdit ? <InfoEditButton onClick={() => setEditing(true)} /> : null}
        </>
      }
      form={form}
      notes={
        diagnostics.warnings.length > 0 && !form ? (
          <ProxyWarnings warnings={diagnostics.warnings} />
        ) : null
      }
    >
      <InfoFact label="Mode" htmlFor={form ? "relay-proxy-mode" : undefined}>
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
      {form || bundled ? (
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
      ) : null}
      {form || bundled ? (
        <InfoFact
          label="Certificate email"
          htmlFor={form ? "relay-acme-email" : undefined}
        >
          {form ? (
            <Input
              id="relay-acme-email"
              name="acmeEmail"
              type="email"
              className="h-8 max-w-60 text-xs"
              defaultValue={settings.acmeEmail ?? ""}
              placeholder="Optional"
            />
          ) : (
            <InfoDetails
              title="Certificate email"
              trigger={settings.acmeEmail ?? "None"}
            >
              <p>
                Let’s Encrypt writes here about certificates the bundled Traefik
                requests, such as ones about to expire.
              </p>
            </InfoDetails>
          )}
        </InfoFact>
      ) : null}
      {!form && bundled ? (
        <>
          <InfoFact label="Traefik">
            {diagnostics.containerRunning ? "Running" : "Not running"}
          </InfoFact>
          <InfoFact label="Public access">
            <InfoDetails
              title="Public access"
              trigger={reachabilityLabel(diagnostics.publicReachability)}
            >
              <p>
                Whether the internet reaches the bundled Traefik, so it can
                serve domains and get certificates for them.
              </p>
            </InfoDetails>
          </InfoFact>
        </>
      ) : null}
      {!form ? (
        <InfoFact label="Ports">
          <ProxyPorts ports={diagnostics.ports} />
        </InfoFact>
      ) : null}
    </InfoSection>
  )
}

function ProxyPorts({ ports }: { ports: RelayProxyDiagnostics["ports"] }) {
  if (ports.length === 0)
    return <span className="text-muted-foreground">—</span>
  const taken = ports.filter((port) => !port.available)
  const summary =
    taken.length === 0
      ? `${ports.map((port) => port.port).join(" and ")} free`
      : taken
          .map((port) =>
            port.owner
              ? `${port.port} used by ${port.owner}`
              : `${port.port} in use`
          )
          .join(", ")
  return (
    <InfoDetails title="Web ports" trigger={summary}>
      <p>The ports a proxy on this node serves web domains from.</p>
      {ports.map((port) => (
        <InfoDetailRow
          key={port.port}
          label={`Port ${port.port}`}
          value={
            port.available
              ? "Free"
              : port.owner
                ? `In use by ${port.owner}`
                : "In use"
          }
        />
      ))}
    </InfoDetails>
  )
}

function ProxyWarnings({ warnings }: { warnings: ReadonlyArray<string> }) {
  return (
    <ul className="flex flex-col gap-2 border-t px-4 py-3">
      {warnings.map((warning) => (
        <li
          key={warning}
          className="flex items-start gap-2 text-xs text-amber-300"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {warning}
        </li>
      ))}
    </ul>
  )
}

function reachabilityLabel(
  reachability: RelayProxyDiagnostics["publicReachability"]
): string {
  if (reachability === "reachable") return "Reachable"
  if (reachability === "unreachable") return "Unreachable"
  return "Unknown"
}
