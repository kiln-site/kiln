import * as React from "react"
import { ChevronsUpDown } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import { GroupPickerCard } from "@/components/group-picker-card"
import { InstanceCard } from "@/components/instance-card"
import {
  InstancePickerChecklist,
  InstancePickerContent,
} from "@/components/instance-picker"
import { VolumePickerCard } from "@/components/volumes/volume-field"
import type { AnyInstancePickerItem } from "@/lib/instance-picker-filters"

// The one picker of what a backup or a schedule runs on. New Backup and the
// schedule editor both draw it, so a row, a group, and what is chosen look
// and behave the same in both; what differs between them is the targets and
// groups each passes.

/** One thing that can be chosen, each a target of its own. */
export interface PickerTarget {
  id: string
  key: string
  /** `platform` is Kiln itself, kept on the Relay `relayId`. */
  kind: "app" | "database" | "instance" | "platform" | "volume"
  name: string
  relayId: string
  relayName: string
  /** What its row says beneath its name: its Relay and ID when unsaid. */
  description?: string | undefined
  /** More that finding it matches, such as the Apps that use a volume. */
  searchText?: string | undefined
  /** It can't be chosen, as without permission to. */
  disabled?: boolean | undefined
  /**
   * It is gone, so it can't be chosen; once chosen, as by a schedule saved
   * before it went, it can still be taken off.
   */
  unavailable?: boolean | undefined
}

/**
 * A row that stands for several targets: an App for the volumes it uses,
 * or a group of instances for its members. Choosing it chooses them, all of
 * them or none, and nothing remembers it was used: what is chosen is them,
 * never the row.
 */
export interface PickerGroup {
  /** What it stands for, or why it can't be chosen. */
  description: string
  id: string
  key: string
  kind: "app" | "group"
  /** The targets it stands for, by key. None when it can't be chosen. */
  members: ReadonlyArray<string>
  name: string
  relayId: string
  searchText?: string
}

const noGroups: ReadonlyArray<PickerGroup> = []

export const TargetPicker = React.memo(function TargetPicker({
  ariaLabel,
  emptyMessage,
  groups = noGroups,
  onToggle,
  placeholder,
  selectedKeys,
  targets,
}: {
  ariaLabel: string
  /** What the list and the field say when there is nothing to choose. */
  emptyMessage: string
  /** Rows that stand for several of `targets`, listed first. */
  groups?: ReadonlyArray<PickerGroup>
  onToggle: (keys: ReadonlyArray<string>, selected: boolean) => void
  placeholder: string
  selectedKeys: ReadonlySet<string>
  targets: ReadonlyArray<PickerTarget>
}) {
  const [open, setOpen] = React.useState(false)
  // Groups first: each is a quick way to what follows it.
  const items = React.useMemo(
    () => [
      ...groups.map(targetPickerGroupItem),
      ...targets.map(targetPickerItem),
    ],
    [groups, targets]
  )
  // One that's gone stays removable while chosen. Only those rows change
  // with what is chosen; the rest are the same rows every time.
  const shown = React.useMemo(() => {
    if (!targets.some((target) => target.unavailable)) return items
    const removable = new Set(
      targets.flatMap((target) =>
        target.unavailable && selectedKeys.has(target.key) ? [target.key] : []
      )
    )
    if (removable.size === 0) return items
    return items.map((item) =>
      removable.has(item.key) ? { ...item, disabled: false } : item
    )
  }, [items, selectedKeys, targets])
  // What is chosen, in the order it is listed.
  const chosen = React.useMemo(
    () => targets.filter((target) => selectedKeys.has(target.key)),
    [selectedKeys, targets]
  )
  const [only] = chosen.length === 1 ? chosen : []
  const onlyItem = React.useMemo(
    () => (only ? targetPickerItem(only) : null),
    [only]
  )
  // Several can be chosen, so the list stays open as each is ticked. A
  // row that stands for others only ticks them: all of them, or none when
  // they all are already.
  const toggleItem = React.useCallback(
    (item: AnyInstancePickerItem) => {
      const keys = item.stands ?? [item.key]
      onToggle(keys, !keys.every((key) => selectedKeys.has(key)))
    },
    [onToggle, selectedKeys]
  )

  return (
    <DrawerPopover open={open} onOpenChange={setOpen}>
      <DrawerPopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={targets.length === 0}
          // One height whatever is chosen, and no wider than its field.
          className="h-12.5 w-full min-w-0 justify-between gap-3 px-2 py-1.5 font-normal"
        >
          {onlyItem?.identity.kind === "volume" ? (
            <VolumePickerCard
              className="min-w-0 flex-1 gap-2 text-left"
              iconClassName="size-7 border-0 bg-muted/55"
              meta={onlyItem.meta}
              name={onlyItem.name}
            />
          ) : onlyItem && onlyItem.identity.kind !== "group" ? (
            <InstanceCard
              className="min-w-0 flex-1 gap-2 text-left"
              iconClassName="size-7 border-0 bg-muted/55"
              instance={onlyItem.identity}
              meta={onlyItem.meta}
              metaClassName="font-mono"
              name={onlyItem.name}
              nameClassName="type-control-sm"
              statusClassName="ring-background"
            />
          ) : chosen.length > 1 ? (
            <span className="min-w-0 flex-1 px-1 text-left">
              <span className="type-control-sm block">
                {chosen.length} targets
              </span>
              <span className="type-meta block truncate text-muted-foreground">
                {chosen.map(({ name }) => name).join(", ")}
              </span>
            </span>
          ) : (
            <span className="truncate px-1 text-muted-foreground">
              {targets.length === 0 ? emptyMessage : placeholder}
            </span>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DrawerPopoverTrigger>
      <DrawerPopoverContent
        title={ariaLabel}
        align="start"
        className="z-[70] w-(--radix-popover-trigger-width) min-w-72 overflow-hidden p-0"
      >
        <InstancePickerContent
          ariaLabel={ariaLabel}
          emptyMessage={emptyMessage}
          items={shown}
          multiple
          selectedKeys={selectedKeys}
          onSelect={toggleItem}
          onSelectMany={onToggle}
        />
      </DrawerPopoverContent>
    </DrawerPopover>
  )
})

/**
 * Targets to tick in place, for a form that's already about a few of them,
 * as a schedule's backup step is about the schedule's.
 */
export const TargetChecklist = React.memo(function TargetChecklist({
  ariaLabel,
  emptyMessage,
  onToggle,
  selectedKeys,
  targets,
}: {
  ariaLabel: string
  emptyMessage: string
  onToggle: (keys: ReadonlyArray<string>, selected: boolean) => void
  selectedKeys: ReadonlySet<string>
  targets: ReadonlyArray<PickerTarget>
}) {
  // One that's gone stays removable while chosen.
  const items = React.useMemo(
    () =>
      targets.map((target) => {
        const item = targetPickerItem(target)
        return target.unavailable && selectedKeys.has(target.key)
          ? { ...item, disabled: false }
          : item
      }),
    [selectedKeys, targets]
  )
  const toggle = React.useCallback(
    (item: AnyInstancePickerItem) =>
      onToggle([item.key], !selectedKeys.has(item.key)),
    [onToggle, selectedKeys]
  )
  return (
    <InstancePickerChecklist
      ariaLabel={ariaLabel}
      emptyMessage={emptyMessage}
      items={items}
      selectedKeys={selectedKeys}
      onToggle={toggle}
    />
  )
})

const kindLabels: Record<PickerTarget["kind"], string> = {
  app: "App",
  database: "Database",
  instance: "Game Server",
  platform: "Kiln",
  volume: "Volume",
}

/** A target's row, as every list of targets draws it. */
export function targetPickerItem(target: PickerTarget): AnyInstancePickerItem {
  const unavailable = target.unavailable === true
  const row = {
    disabled: target.disabled === true || unavailable,
    key: target.key,
  }
  if (target.kind === "platform") {
    return {
      ...row,
      identity: {
        id: target.relayId,
        kind: "relay",
        platform: true,
        relayId: target.relayId,
        source: "fleet",
      },
      meta: unavailable
        ? `Unavailable · On ${target.relayName}`
        : `On ${target.relayName}`,
      name: "Kiln",
      searchText: `kiln hearth platform ${target.relayName} ${target.relayId}`,
    }
  }
  const searchText = `${kindLabels[target.kind]} ${target.id} ${target.relayName} ${target.searchText ?? ""}`
  if (target.kind === "volume") {
    // A volume's own card, as its Relay's volumes and an App's show it.
    const meta = unavailable
      ? `Unavailable · ${target.relayName}`
      : (target.description ?? `${target.relayName} · ${target.id.slice(0, 8)}`)
    return {
      ...row,
      card: <VolumePickerCard meta={meta} name={target.name} />,
      identity: { id: target.id, kind: "volume", relayId: target.relayId },
      meta,
      name: target.name,
      searchText,
    }
  }
  return {
    ...row,
    identity: {
      id: target.id,
      kind: target.kind === "instance" ? "server" : target.kind,
      relayId: target.relayId,
    },
    meta: unavailable
      ? `Unavailable · ${kindLabels[target.kind]} · ${target.relayName}`
      : (target.description ?? `${target.relayName} · ${target.id}`),
    name: target.name,
    searchText,
  }
}

// A group's row: an App's own card, or a group's, saying what it stands for.
function targetPickerGroupItem(group: PickerGroup): AnyInstancePickerItem {
  const row = {
    disabled: group.members.length === 0,
    key: group.key,
    meta: group.description,
    name: group.name,
    searchText: `${group.id} ${group.searchText ?? ""}`,
    stands: group.members,
  }
  return group.kind === "app"
    ? {
        ...row,
        identity: { id: group.id, kind: "app", relayId: group.relayId },
      }
    : {
        ...row,
        card: <GroupPickerCard meta={group.description} name={group.name} />,
        identity: { id: group.id, kind: "group" },
      }
}
