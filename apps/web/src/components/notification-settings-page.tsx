import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import {
  AppWindow,
  BellRing,
  HardDrive,
  Rocket,
  ShieldAlert,
  UserPlus,
} from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"
import { Switch } from "@workspace/ui/components/switch"

import { PushNotificationsToggle } from "@/components/push-notifications-toggle"
import { SettingsPage, SettingsPanel } from "@/components/settings-panel"
import {
  notificationPreferencesQueryOptions,
  saveNotificationPreferencesMutationOptions,
} from "@/lib/collections/notifications"
import {
  notificationIdleMinuteOptions,
  notificationPreferenceGroups,
  type NotificationKindPreference,
  type NotificationPreferencesUpdate,
} from "@/lib/notification-preferences"
import type { NotificationKind } from "@/lib/notifications"
import type { SecurityNotificationSettings } from "@/lib/security"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

const groupIcons = {
  access: <UserPlus />,
  apps: <AppWindow />,
  kiln: <Rocket />,
  resources: <HardDrive />,
  security: <ShieldAlert />,
} satisfies Record<
  (typeof notificationPreferenceGroups)[number]["id"],
  React.ReactNode
>

function minutesLabel(minutes: number) {
  return minutes === 1 ? "1 minute" : `${minutes} minutes`
}

function selectPlatformAdmin(capabilities: { isPlatformAdmin: boolean }) {
  return capabilities.isPlatformAdmin
}

export const NotificationSettingsPage = React.memo(
  function NotificationSettingsPage() {
    const queryClient = useQueryClient()
    const { data: preferences } = useSuspenseQuery(
      notificationPreferencesQueryOptions()
    )
    const { data: platformAdmin = false } = useQuery({
      ...accessCapabilitiesQueryOptions(),
      select: selectPlatformAdmin,
    })
    const { mutate } = useMutation(
      saveNotificationPreferencesMutationOptions(queryClient, (error) =>
        showToast({
          message: `Could not save notification settings: ${error.message}`,
          type: "error",
        })
      )
    )
    const save = React.useCallback(
      (update: NotificationPreferencesUpdate) => mutate(update),
      [mutate]
    )
    const setKind = React.useCallback(
      (kind: NotificationKind, choice: NotificationKindPreference) =>
        save({ kinds: { [kind]: choice } }),
      [save]
    )

    return (
      <SettingsPage className="lg:grid-cols-2 lg:items-start">
        <SettingsPanel icon={<BellRing />} title="Delivery">
          <PreferenceRow
            label="Push to this device"
            description="Sends notifications to this browser or installed app, even while Kiln is closed."
          >
            <PushNotificationsToggle />
          </PreferenceRow>
          <PreferenceRow
            label="Skip push while I'm active"
            description="A notification you see in Kiln isn't pushed to your devices too."
          >
            <Switch
              aria-label="Skip push while I'm active"
              checked={preferences.skipPushWhileActive}
              onCheckedChange={(skipPushWhileActive) =>
                save({ skipPushWhileActive })
              }
            />
          </PreferenceRow>
          <PreferenceRow
            label="Away after"
            description="With no input for this long, Kiln pushes even while it's open."
          >
            <Select
              value={String(preferences.idleMinutes)}
              disabled={!preferences.skipPushWhileActive}
              onValueChange={(value) => save({ idleMinutes: Number(value) })}
            >
              <SelectTrigger aria-label="Away after" className="h-8 w-32">
                <SelectValue>
                  {minutesLabel(preferences.idleMinutes)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {notificationIdleMinuteOptions.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {minutesLabel(minutes)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PreferenceRow>
        </SettingsPanel>

        {notificationPreferenceGroups.map((group) =>
          group.adminOnly && !platformAdmin ? null : (
            <SettingsPanel
              key={group.id}
              icon={groupIcons[group.id]}
              title={group.label}
              action={<ChannelHeadings />}
            >
              {group.kinds.map((entry) => (
                <KindRow
                  key={entry.kind}
                  choice={preferences.kinds[entry.kind]}
                  group={group.label}
                  inboxRequired={"inboxRequired" in entry}
                  kind={entry.kind}
                  label={entry.label}
                  onChange={setKind}
                />
              ))}
              {group.id === "security" ? (
                <SecurityPreferences
                  choice={preferences.security}
                  disabled={
                    !preferences.kinds["security.vulnerabilities"].inbox
                  }
                  onChange={save}
                />
              ) : null}
            </SettingsPanel>
          )
        )}
      </SettingsPage>
    )
  }
)

const channelColumn = "flex w-[4.5rem] shrink-0 justify-center"

// The two switches' columns, above them in the panel's header.
function ChannelHeadings() {
  return (
    <div className="type-meta flex text-muted-foreground" aria-hidden>
      <span className={channelColumn}>In Kiln</span>
      <span className={channelColumn}>Push</span>
    </div>
  )
}

const KindRow = React.memo(function KindRow({
  choice,
  group,
  inboxRequired,
  kind,
  label,
  onChange,
}: {
  choice: NotificationKindPreference
  group: string
  inboxRequired: boolean
  kind: NotificationKind
  label: string
  onChange: (kind: NotificationKind, choice: NotificationKindPreference) => void
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 border-b px-4 py-2.5 last:border-b-0">
      <p className="min-w-0 flex-1 text-sm font-medium">{label}</p>
      <div className="flex">
        <span className={channelColumn}>
          <Switch
            aria-label={`${label} (${group}): show in Kiln`}
            checked={choice.inbox}
            disabled={inboxRequired}
            onCheckedChange={(inbox) => onChange(kind, { ...choice, inbox })}
          />
        </span>
        <span className={channelColumn}>
          <Switch
            aria-label={`${label} (${group}): push`}
            checked={choice.inbox && choice.push}
            disabled={!choice.inbox}
            onCheckedChange={(push) => onChange(kind, { ...choice, push })}
          />
        </span>
      </div>
    </div>
  )
})

const severityOptions = [
  { label: "Critical only", value: "critical" },
  { label: "High and critical", value: "high" },
  { label: "Medium and above", value: "medium" },
  { label: "Every severity", value: "low" },
] as const satisfies ReadonlyArray<{
  label: string
  value: SecurityNotificationSettings["severity"]
}>

// Which vulnerabilities in what the user can update notify them. Ones being
// exploited in the wild do whatever these say.
const SecurityPreferences = React.memo(function SecurityPreferences({
  choice,
  disabled,
  onChange,
}: {
  choice: SecurityNotificationSettings
  disabled: boolean
  onChange: (update: NotificationPreferencesUpdate) => void
}) {
  return (
    <>
      <PreferenceRow
        label="Least severe"
        description="Vulnerabilities known to be exploited notify at any severity."
      >
        <Select
          value={choice.severity}
          disabled={disabled}
          onValueChange={(severity) =>
            onChange({
              security: {
                severity: severity as SecurityNotificationSettings["severity"],
              },
            })
          }
        >
          <SelectTrigger aria-label="Least severe" className="h-8 w-44">
            <SelectValue>
              {
                severityOptions.find(
                  (option) => option.value === choice.severity
                )?.label
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {severityOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PreferenceRow>
      <PreferenceRow
        label="Only when an update fixes it"
        description="Leaves out vulnerabilities nobody has released a fix for yet."
      >
        <Switch
          aria-label="Only when an update fixes it"
          checked={choice.fixableOnly}
          disabled={disabled}
          onCheckedChange={(fixableOnly) =>
            onChange({ security: { fixableOnly } })
          }
        />
      </PreferenceRow>
    </>
  )
})

function PreferenceRow({
  children,
  description,
  label,
}: {
  children: React.ReactNode
  description: string
  label: string
}) {
  return (
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm font-medium">{label}</p>
        <p className="type-meta mt-0.5 text-muted-foreground">{description}</p>
      </div>
      <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
        {children}
      </div>
    </div>
  )
}
