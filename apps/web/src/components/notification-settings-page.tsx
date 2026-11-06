import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Bell, BellOff, BellRing, ChevronDown, Users } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"

import { InfoFact, InfoRailCard } from "@/components/info-page"
import { PushNotificationsToggle } from "@/components/push-notifications-toggle"
import { SettingsPage, SettingsPanel } from "@/components/settings-panel"
import {
  notificationPreferencesQueryOptions,
  saveNotificationPreferencesMutationOptions,
} from "@/lib/collections/notifications"
import {
  notificationChannels,
  notificationIdleMinuteOptions,
  notificationKindLabel,
  notificationPreferenceGroups,
  notificationScopeLabels,
  notificationScopes,
  type NotificationKindPreference,
  type NotificationPreferences,
  type NotificationPreferencesUpdate,
  type NotificationScope,
} from "@/lib/notification-preferences"
import type { NotificationKind } from "@/lib/notifications"
import { resourceTypeLabels } from "@/lib/notification-text"
import type { SecurityNotificationSettings } from "@/lib/security"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

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
      // The list of what's heard fills the page, and what applies to all of it
      // stays in view beside it, like an Info page's rail.
      <SettingsPage
        fill
        className="max-w-none lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start"
      >
        <SettingsPanel
          className="lg:max-h-full"
          icon={<Bell />}
          title="What you hear"
        >
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {notificationPreferenceGroups.map((group) => (
              <React.Fragment key={group.id}>
                <GroupLabel>{group.label}</GroupLabel>
                {group.kinds.map((entry) =>
                  "adminOnly" in entry && !platformAdmin ? null : (
                    <React.Fragment key={entry.kind}>
                      <KindRow
                        choice={preferences.kinds[entry.kind]}
                        description={entry.description}
                        inboxRequired={"inboxRequired" in entry}
                        kind={entry.kind}
                        label={entry.label}
                        onChange={setKind}
                      />
                      {entry.kind === "security.report" ? (
                        <SecurityPreferences
                          choice={preferences.security}
                          disabled={!preferences.kinds[entry.kind].inbox}
                          onChange={save}
                        />
                      ) : null}
                    </React.Fragment>
                  )
                )}
              </React.Fragment>
            ))}
          </div>
        </SettingsPanel>
        <aside className="min-w-0 lg:max-h-full lg:overflow-y-auto">
          <DeliveryCard
            idleMinutes={preferences.idleMinutes}
            skipPushWhileActive={preferences.skipPushWhileActive}
            onChange={save}
          />
          <ScopeCard value={preferences.scope} onChange={save} />
          <CustomizedCard resources={preferences.resources} onChange={save} />
        </aside>
      </SettingsPage>
    )
  }
)

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="type-technical-label sticky top-0 z-10 border-b bg-muted px-4 py-1.5 text-muted-foreground">
      {children}
    </h3>
  )
}

function channelSummary(choice: NotificationKindPreference) {
  const on = notificationChannels.filter(
    ({ key }) => choice.inbox && choice[key]
  )
  return on.map(({ label }) => label).join(", ") || "Off"
}

// One row per notification, and one menu for wherever it goes, however many
// channels there are.
const KindRow = React.memo(function KindRow({
  choice,
  description,
  inboxRequired,
  kind,
  label,
  onChange,
}: {
  choice: NotificationKindPreference
  description: string
  inboxRequired: boolean
  kind: NotificationKind
  label: string
  onChange: (kind: NotificationKind, choice: NotificationKindPreference) => void
}) {
  const summary = channelSummary(choice)
  return (
    <PreferenceRow label={label} description={description}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="w-44 shrink-0 justify-between font-normal"
            aria-label={`${label}: ${summary}`}
          >
            <span className="truncate">{summary}</span>
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {notificationChannels.map(({ key, label: channel }) => (
            <DropdownMenuCheckboxItem
              key={key}
              checked={choice.inbox && choice[key]}
              disabled={key === "inbox" ? inboxRequired : !choice.inbox}
              // It stays open, to choose several.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(on) =>
                onChange(kind, { ...choice, [key]: on === true })
              }
            >
              {channel}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </PreferenceRow>
  )
})

const DeliveryCard = React.memo(function DeliveryCard({
  idleMinutes,
  onChange,
  skipPushWhileActive,
}: {
  idleMinutes: number
  onChange: (update: NotificationPreferencesUpdate) => void
  skipPushWhileActive: boolean
}) {
  return (
    <InfoRailCard
      // Every row the same height, whatever its control.
      className="[&_dl>div]:min-h-12"
      icon={<BellRing />}
      title="Delivery"
    >
      <InfoFact label="Push to this device">
        <PushNotificationsToggle className="w-32" size="default" />
      </InfoFact>
      <InfoFact label="Skip push while active">
        <Switch
          aria-label="Skip push while active"
          checked={skipPushWhileActive}
          onCheckedChange={(skipPushWhileActive) =>
            onChange({ skipPushWhileActive })
          }
        />
      </InfoFact>
      <InfoFact label="Away after">
        <Select
          value={String(idleMinutes)}
          disabled={!skipPushWhileActive}
          onValueChange={(value) => onChange({ idleMinutes: Number(value) })}
        >
          <SelectTrigger aria-label="Away after" className="h-8 w-32">
            <SelectValue>{minutesLabel(idleMinutes)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {notificationIdleMinuteOptions.map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)}>
                {minutesLabel(minutes)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </InfoFact>
    </InfoRailCard>
  )
})

// Whose instances the person hears about, every choice in view.
const ScopeCard = React.memo(function ScopeCard({
  onChange,
  value,
}: {
  onChange: (update: NotificationPreferencesUpdate) => void
  value: NotificationScope
}) {
  return (
    <InfoRailCard icon={<Users />} title="Whose instances">
      <div role="radiogroup" aria-label="Whose instances" className="-mx-3">
        {notificationScopes.map((scope) => (
          <label
            key={scope}
            className="flex min-h-10 w-full cursor-pointer items-center gap-2.5 border-b border-border/60 px-3 text-[0.8125rem] transition-colors last:border-b-0 hover:bg-accent/50 has-[:focus-visible]:bg-accent/50"
          >
            <input
              type="radio"
              name="notification-scope"
              className="sr-only"
              checked={scope === value}
              onChange={() => onChange({ scope })}
            />
            <span
              aria-hidden
              className={cn(
                "size-3 shrink-0 rounded-full border border-muted-foreground",
                scope === value && "border-4 border-primary"
              )}
            />
            {notificationScopeLabels[scope]}
          </label>
        ))}
      </div>
    </InfoRailCard>
  )
})

// What the person turned off about particular instances, to turn back on.
const CustomizedCard = React.memo(function CustomizedCard({
  onChange,
  resources,
}: {
  onChange: (update: NotificationPreferencesUpdate) => void
  resources: NotificationPreferences["resources"]
}) {
  const entries = Object.entries(resources)
  if (!entries.length) return null
  return (
    <InfoRailCard icon={<BellOff />} title="Customized">
      {entries.map(([key, resource]) => (
        <div
          key={key}
          className="flex min-h-10 items-center gap-3 border-b border-border/60 py-1.5 text-[0.8125rem] last:border-b-0"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{resource.name}</p>
            <p className="type-meta truncate text-muted-foreground">
              {resourceTypeLabels[resource.type]} ·{" "}
              {Object.keys(resource.kinds)
                .map((kind) => notificationKindLabel(kind as NotificationKind))
                .join(", ")}{" "}
              off
            </p>
          </div>
          <Button
            variant="outline"
            size="xs"
            onClick={() => onChange({ resources: { [key]: null } })}
          >
            Reset
          </Button>
        </div>
      ))}
    </InfoRailCard>
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
        description="Ones known to be exploited notify at any severity."
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
        description="Leaves out ones with no fix yet."
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
