import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  APP_SERVICE,
  NO_RESOURCE_LIMITS,
  type AppConfig,
  type ResourceLimits,
} from "@workspace/contracts"

import {
  appContainers,
  appRelayAvailable,
  appServices,
  type App,
} from "@/components/app/app-presentation"
import {
  ResourceLimitsDialog,
  type ResourceLimitsGroup,
} from "@/components/resource-limits/resource-limits-section"
import { appConfigQueryOptions, queryKeys } from "@/lib/query-options"
import type { ResourceLimitField } from "@/lib/resource-limits"
import { updateAppLimits } from "@/server/apps"

// An app's services share its data, so each has its own memory and CPU and
// there's no disk limit to set. The dialog opens on the service the
// Container section shows, and saves every service's limits.
const SERVICE_FIELDS: ReadonlyArray<ResourceLimitField> = [
  "memoryGiB",
  "cpuCores",
]

export function AppLimitsDialog({
  app,
  config,
  onOpenChange,
  service,
}: {
  app: App
  config: AppConfig
  onOpenChange: (open: boolean) => void
  // The service whose limits show, or none for every service, as before an
  // app's first deploy.
  service: string | null
}) {
  const queryClient = useQueryClient()
  const available = appRelayAvailable(app)
  const services = limitedServices(app, config).join("\n")
  const { serviceLimits } = config
  const groups = React.useMemo<ReadonlyArray<ResourceLimitsGroup>>(() => {
    const names = services === "" ? [] : services.split("\n")
    return names.map((name) => ({
      fields: SERVICE_FIELDS,
      key: name,
      ...(names.length > 1 ? { label: name } : {}),
      limits: { ...NO_RESOURCE_LIMITS, ...serviceLimits[name] },
    }))
  }, [serviceLimits, services])
  const save = React.useCallback(
    async (limits: Readonly<Record<string, ResourceLimits>>) => {
      await updateAppLimits({
        data: {
          appId: app.id,
          relayId: app.relayId,
          serviceLimits: {
            ...serviceLimits,
            ...Object.fromEntries(
              Object.entries(limits).map(([name, value]) => [
                name,
                { cpuMillis: value.cpuMillis, memoryBytes: value.memoryBytes },
              ])
            ),
          },
        },
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
        queryClient.invalidateQueries({
          queryKey: appConfigQueryOptions(app.relayId, app.id).queryKey,
        }),
      ])
    },
    [app.id, app.relayId, queryClient, serviceLimits]
  )
  return (
    <ResourceLimitsDialog
      disabledReason={
        available ? undefined : "Reconnect this App's Relay first"
      }
      editable={app.permissions.includes("instance.limits.write")}
      groups={groups}
      hint="Memory and CPU change at once. A limit taken off applies the next time the app deploys."
      shownGroup={
        service === null
          ? undefined
          : groups.some((group) => group.key === service)
            ? service
            : groups[0]?.key
      }
      target={{ id: app.id, kind: "app", relayId: app.relayId }}
      title="Resource limits"
      onOpenChange={onOpenChange}
      onSave={save}
    />
  )
}

// Docker can't take a limit off a running container, so a limit removed
// stays on it until the next deploy.
export function appLimitsPendingDeploy(
  app: App,
  { serviceLimits }: AppConfig
): boolean {
  return appContainers(app).some(({ limits, service }) => {
    const saved = serviceLimits[service]
    return (
      saved !== undefined &&
      (saved.cpuMillis !== (limits?.cpuMillis ?? null) ||
        saved.memoryBytes !== (limits?.memoryBytes ?? null))
    )
  })
}

// What's running, or before the first deployment, what's been limited
// already, or the one service anything but Compose runs.
function limitedServices(app: App, config: AppConfig): ReadonlyArray<string> {
  const running = appServices(app)
  if (running.length > 0) return running
  const limited = Object.keys(config.serviceLimits)
  if (limited.length > 0) return limited
  return config.sourceType === "compose" ? [] : [APP_SERVICE]
}
