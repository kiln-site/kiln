import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  APP_SERVICE,
  NO_RESOURCE_LIMITS,
  type AppConfig,
  type ResourceLimits,
} from "@workspace/contracts"
import { Gauge } from "lucide-react"

import {
  appContainers,
  appRelayAvailable,
  appServices,
  type App,
} from "@/components/app/app-presentation"
import { useSelectedAppContainer } from "@/components/app/app-container-selection"
import { DeployToApplyButton } from "@/components/app/app-settings"
import { InfoPager, InfoSection } from "@/components/info-page"
import {
  ResourceLimitsSection,
  type ResourceLimitsGroup,
} from "@/components/resource-limits/resource-limits-section"
import { appConfigQueryOptions, queryKeys } from "@/lib/query-options"
import { StatusIndicator } from "@/components/status-indicator"
import type { ResourceLimitField } from "@/lib/resource-limits"
import { updateAppLimits } from "@/server/apps"

// An app's services share its data, so each has its own memory and CPU and
// there's no disk limit to set. One shows at a time, paged through like the
// Container section, and the two stay on the same service.
const SERVICE_FIELDS: ReadonlyArray<ResourceLimitField> = [
  "memoryGiB",
  "cpuCores",
]

const PENDING_DEPLOY = {
  detail: "Deploy this app to remove the limits taken off its services.",
  label: "Pending deploy",
  tone: "warning",
} as const

export function AppLimitsSection({
  app,
  config,
}: {
  app: App
  config: AppConfig
}) {
  const queryClient = useQueryClient()
  const canManage = app.permissions.includes("app.manage")
  const available = appRelayAvailable(app)
  const pending = deployPending(app, config)
  const services = limitedServices(app, config).join("\n")
  const { serviceLimits } = config
  const { select, selected } = useSelectedAppContainer()
  const groups = React.useMemo<ReadonlyArray<ResourceLimitsGroup>>(() => {
    const names = services === "" ? [] : services.split("\n")
    return names.map((service) => ({
      fields: SERVICE_FIELDS,
      key: service,
      ...(names.length > 1 ? { label: service } : {}),
      limits: { ...NO_RESOURCE_LIMITS, ...serviceLimits[service] },
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
              Object.entries(limits).map(([service, value]) => [
                service,
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
  const shownIndex = Math.max(
    groups.findIndex((group) => group.key === selected?.service),
    0
  )
  const step = (offset: number) => {
    const next = groups[(shownIndex + offset + groups.length) % groups.length]
    if (next) select({ service: next.key })
  }
  if (groups.length === 0) {
    return (
      <InfoSection content icon={<Gauge />} title="Resource limits">
        <p className="type-support text-muted-foreground">
          Deploy the app to set limits for its services.
        </p>
      </InfoSection>
    )
  }
  return (
    <ResourceLimitsSection
      action={
        pending && canManage && available ? (
          <DeployToApplyButton app={app} />
        ) : null
      }
      disabledReason={
        available ? undefined : "Reconnect this App's Relay first"
      }
      editable={canManage}
      groups={groups}
      hint="Changing memory or CPU applies at once. Removing a limit applies the next time the app deploys."
      shownGroup={groups[shownIndex]?.key}
      status={
        <>
          {groups.length > 1 ? (
            <InfoPager
              count={groups.length}
              index={shownIndex}
              noun="service"
              onStep={step}
            />
          ) : null}
          {pending ? <StatusIndicator status={PENDING_DEPLOY} /> : null}
        </>
      }
      target={{ id: app.id, kind: "app", relayId: app.relayId }}
      onSave={save}
    />
  )
}

// Docker can't take a limit off a running container, so a limit removed
// stays on it until the next deploy.
function deployPending(app: App, { serviceLimits }: AppConfig): boolean {
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
