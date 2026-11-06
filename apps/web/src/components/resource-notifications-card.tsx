import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Bell, Settings2 } from "lucide-react"

import { showToast } from "@workspace/ui/components/sonner"
import { Switch } from "@workspace/ui/components/switch"

import { InfoRailCard } from "@/components/info-page"
import {
  notificationPreferencesQueryOptions,
  saveNotificationPreferencesMutationOptions,
} from "@/lib/collections/notifications"
import {
  notificationKindLabel,
  type NotificationPreferencesUpdate,
} from "@/lib/notification-preferences"
import {
  notificationResourceKey,
  type NotificationKind,
  type NotificationResource,
} from "@/lib/notifications"

// The last card on an instance's Info rail: what this person hears about this
// one, whatever they hear about others. A kind turned off everywhere stays off
// here, and settings is where to change that.
export const ResourceNotificationsCard = React.memo(
  function ResourceNotificationsCard({
    kinds,
    resource,
  }: {
    kinds: ReadonlyArray<NotificationKind>
    resource: NotificationResource
  }) {
    const queryClient = useQueryClient()
    const { data: preferences } = useQuery(
      notificationPreferencesQueryOptions()
    )
    const { mutate: save } = useMutation(
      saveNotificationPreferencesMutationOptions(queryClient, (error) =>
        showToast({
          message: `Could not save notification settings: ${error.message}`,
          type: "error",
        })
      )
    )
    if (!kinds.length) return null
    const key = notificationResourceKey(resource)
    const current = preferences?.resources[key]
    const setKind = (kind: NotificationKind, on: boolean) => {
      const { [kind]: _changed, ...others } = current?.kinds ?? {}
      const next = on ? others : { ...others, [kind]: false as const }
      const update: NotificationPreferencesUpdate = {
        resources: {
          [key]: Object.keys(next).length
            ? { kinds: next, name: resource.name, type: resource.type }
            : null,
        },
      }
      save(update)
    }
    return (
      <InfoRailCard
        icon={<Bell />}
        title="Notifications"
        action={
          <Link
            to="/settings/notifications"
            aria-label="Notification settings"
            className="grid size-6 place-items-center text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3.5"
          >
            <Settings2 />
          </Link>
        }
      >
        {kinds.map((kind) => {
          const label = notificationKindLabel(kind)
          const everywhere = preferences?.kinds[kind].inbox ?? true
          return (
            <div
              key={kind}
              className="flex min-h-9 items-center justify-between gap-3 border-b border-border/60 py-1.5 text-[0.8125rem] last:border-b-0"
            >
              <span
                className="min-w-0 truncate"
                title={
                  everywhere ? undefined : "Turned off in notification settings"
                }
              >
                {label}
              </span>
              <Switch
                aria-label={`${label} for ${resource.name}`}
                checked={everywhere && current?.kinds[kind] !== false}
                disabled={!preferences || !everywhere}
                onCheckedChange={(on) => setKind(kind, on)}
              />
            </div>
          )
        })}
      </InfoRailCard>
    )
  }
)
