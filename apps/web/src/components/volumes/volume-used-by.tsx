import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import type { RelayVolume, RelayVolumeMount } from "@workspace/contracts"
import { Container } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import { AppKindIcon } from "@/components/instance-kind-icon"
import {
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import { appDirectoryQueryOptions } from "@/lib/query-options"

// The apps whose containers mount a volume, and how many containers that
// is; the list groups them by app.
export const VolumeUsedBy = React.memo(function VolumeUsedBy({
  relayId,
  relayName,
  volume,
}: {
  relayId: string
  // For the Relay's own data volume, the one thing the Relay itself mounts.
  relayName: string
  volume: Pick<RelayVolume, "mounts" | "name" | "users">
}) {
  const [open, setOpen] = React.useState(false)
  const close = React.useCallback(() => setOpen(false), [])
  const apps = volume.users.length
  const containers = volume.mounts.length
  return (
    <DrawerPopover open={open} onOpenChange={setOpen}>
      <DrawerPopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${apps} ${apps === 1 ? "App uses" : "Apps use"} ${volume.name}, and ${containers} ${containers === 1 ? "container mounts" : "containers mount"} it`}
          className="type-meta relative z-10 -mx-1.5 flex h-8 min-w-0 items-center gap-3 rounded-md px-1.5 text-muted-foreground transition-colors outline-none hover:bg-muted/55 focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-muted/55"
        >
          <MountCount count={apps} icon={AppKindIcon} one="App" other="Apps" />
          <MountCount
            count={containers}
            icon={Container}
            one="container"
            other="containers"
          />
        </button>
      </DrawerPopoverTrigger>
      <DrawerPopoverContent
        title="Used by"
        aria-label="Used by"
        align="start"
        sideOffset={6}
        className="w-72 max-w-[calc(100vw-1rem)] overflow-hidden p-0"
      >
        <VolumeMountPicker
          relayId={relayId}
          relayName={relayName}
          volume={volume}
          onNavigate={close}
        />
      </DrawerPopoverContent>
    </DrawerPopover>
  )
})

function MountCount({
  count,
  icon: Icon,
  one,
  other,
}: {
  count: number
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  one: string
  other: string
}) {
  return (
    <span
      title={`${count} ${count === 1 ? one : other}`}
      className={cn(
        "pointer-events-none flex items-center gap-1 tabular-nums",
        count ? "text-foreground" : "opacity-40"
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {count}
    </span>
  )
}

const noSelectedMounts: ReadonlySet<string> = new Set()

// What mounts a volume, as the Automations targets list shows its targets:
// one row per app, however many of its containers mount it.
const VolumeMountPicker = React.memo(function VolumeMountPicker({
  relayId,
  relayName,
  volume,
  onNavigate,
}: {
  relayId: string
  relayName: string
  volume: Pick<RelayVolume, "mounts" | "name" | "users">
  onNavigate: () => void
}) {
  const navigate = useNavigate()
  const { data: appNames } = useQuery({
    ...appDirectoryQueryOptions(),
    select: selectAppNames,
  })
  const items = React.useMemo(
    () => volumeMountItems(volume, relayId, relayName, appNames),
    [appNames, relayId, relayName, volume]
  )
  const select = React.useCallback(
    (item: InstancePickerItem) => {
      onNavigate()
      void navigate({ href: mountHref(item.identity) })
    },
    [navigate, onNavigate]
  )
  return (
    <InstancePickerContent
      ariaLabel="Used by"
      emptyMessage="Nothing uses this volume"
      favoritesFilter={false}
      includeKindGroups={false}
      items={items}
      selectedKeys={noSelectedMounts}
      onSelect={select}
    />
  )
})

function selectAppNames(apps: ReadonlyArray<{ id: string; name: string }>) {
  return new Map(apps.map((app) => [app.id, app.name]))
}

function volumeMountItems(
  volume: Pick<RelayVolume, "mounts" | "users">,
  relayId: string,
  relayName: string,
  appNames: ReadonlyMap<string, string> | undefined
): Array<InstancePickerItem> {
  const groups = new Map<
    string,
    {
      identity: InstancePickerItem["identity"]
      mounts: Array<RelayVolumeMount>
      name: string
    }
  >()
  for (const mount of volume.mounts) {
    const id = mount.resourceId
    const target =
      mount.kind === "relay"
        ? {
            identity: {
              id: relayId,
              kind: "relay",
              relayId,
              source: "fleet",
            } as const,
            key: "relay",
            name: relayName,
          }
        : mount.kind === "app" && id
          ? {
              identity: { id, kind: "app", relayId } as const,
              key: `app:${id}`,
              name: appName(appNames, id),
            }
          : mount.kind === "database" && id
            ? {
                identity: { id, kind: "database", relayId } as const,
                key: `database:${id}`,
                name: `Database ${id.slice(0, 8)}`,
              }
            : mount.kind === "instance" && id
              ? {
                  identity: { id, kind: "server", relayId } as const,
                  key: `server:${id}`,
                  name: `Game server ${id.slice(0, 8)}`,
                }
              : null
    // Containers Kiln doesn't run only count toward the total.
    if (!target) continue
    const group = groups.get(target.key)
    if (group) group.mounts.push(mount)
    else groups.set(target.key, { ...target, mounts: [mount] })
  }
  // Apps whose configuration names it but that have no container now.
  for (const user of volume.users) {
    const key = `app:${user.appId}`
    if (groups.has(key)) continue
    groups.set(key, {
      identity: { id: user.appId, kind: "app", relayId },
      mounts: [],
      name: appName(appNames, user.appId),
    })
  }
  return [...groups].map(([key, group]) => {
    const containers = group.mounts.length
    const paths = [...new Set(group.mounts.map((mount) => mount.destination))]
    return {
      identity: group.identity,
      key,
      meta: containers
        ? `${containers} ${containers === 1 ? "container" : "containers"} · ${paths.join(", ")}`
        : "Its configuration mounts it",
      name: group.name,
      searchText: [
        ...group.mounts.map((mount) => mount.container),
        ...paths,
      ].join(" "),
    }
  })
}

// Each workspace route takes a full ID and redirects to its short form.
function mountHref(identity: InstancePickerItem["identity"]): string {
  if (identity.kind === "server") {
    return `/server/${encodeURIComponent(`${identity.relayId}-${identity.id}`)}`
  }
  if (identity.kind === "database") {
    return `/db/${encodeURIComponent(identity.id)}`
  }
  if (identity.kind === "app") return `/app/${encodeURIComponent(identity.id)}`
  return `/relay/${encodeURIComponent(identity.relayId)}`
}

function appName(
  appNames: ReadonlyMap<string, string> | undefined,
  appId: string
): string {
  return appNames?.get(appId) ?? `App ${appId.slice(0, 8)}`
}
