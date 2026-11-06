import * as React from "react"
import { useNavigate, type NavigateOptions } from "@tanstack/react-router"
import type { RelayVolume } from "@workspace/contracts"
import { ChevronsUpDown, Folder, HardDrive } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import {
  InstancePickerContent,
  InstancePickerHeaderAction,
} from "@/components/instance-picker"
import { volumeCardMeta } from "@/components/volumes/volume-card"
import {
  VolumePickerCard,
  type VolumePickerItem,
} from "@/components/volumes/volume-field"
import type { VolumeLink } from "@/components/volumes/volume-parts"

export interface VolumeFileRoot extends Pick<
  RelayVolume,
  "dockerName" | "id" | "kind" | "sizeBytes"
> {
  key: string
  link: VolumeLink
  name: string
}

// Above a Files page: what it's showing, the App's folder or the Relay's
// host files, or one of its volumes, and the way to the others. A page with
// no volumes shows nothing.
export const VolumeFileRootBar = React.memo(function VolumeFileRootBar({
  currentKey,
  home,
  path,
  relayId,
  volumes,
}: {
  // The volume open now; null for `home`.
  currentKey: string | null
  home: { link: VolumeLink; name: string }
  // Where the open volume is mounted, shown beside its name.
  path?: string | undefined
  relayId: string
  volumes: ReadonlyArray<VolumeFileRoot>
}) {
  const [open, setOpen] = React.useState(false)
  const navigate = useNavigate()
  const items = React.useMemo(
    () =>
      volumes.map((volume): VolumePickerItem => {
        const meta = volumeCardMeta(volume)
        return {
          card: (
            <VolumePickerCard
              kind={volume.kind}
              meta={meta}
              name={volume.name}
            />
          ),
          identity: { id: volume.key, kind: "volume", relayId },
          key: volume.key,
          meta,
          name: volume.name,
          searchText: volume.dockerName,
        }
      }),
    [relayId, volumes]
  )
  const selectedKeys = React.useMemo(
    () => new Set(currentKey ? [currentKey] : []),
    [currentKey]
  )
  const go = React.useCallback(
    (link: VolumeLink) => {
      setOpen(false)
      void navigate(link as NavigateOptions)
    },
    [navigate]
  )
  const select = React.useCallback(
    (item: VolumePickerItem) => {
      const volume = volumes.find(({ key }) => key === item.key)
      if (volume) go(volume.link)
    },
    [go, volumes]
  )
  const goHome = React.useCallback(() => go(home.link), [go, home.link])
  if (volumes.length === 0) return null
  const current = volumes.find((volume) => volume.key === currentKey)
  return (
    <div className="flex h-10 min-w-0 shrink-0 items-center gap-2 border-b bg-card px-2">
      <DrawerPopover open={open} onOpenChange={setOpen}>
        <DrawerPopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className="min-w-0"
            role="combobox"
            size="sm"
            type="button"
            variant="ghost"
          >
            {currentKey ? <HardDrive /> : <Folder />}
            <span className="truncate">
              {currentKey ? (current?.name ?? "Volume") : home.name}
            </span>
            <ChevronsUpDown className="text-muted-foreground" />
          </Button>
        </DrawerPopoverTrigger>
        <DrawerPopoverContent
          title="Volumes"
          align="start"
          className="w-80 max-w-[calc(100vw-1rem)] overflow-hidden p-0"
        >
          <InstancePickerContent
            ariaLabel="Volumes"
            emptyMessage="No volumes"
            favoritesFilter={false}
            filterBar={false}
            header={
              <InstancePickerHeaderAction
                label={home.name}
                selected={currentKey === null}
                onClick={goHome}
              />
            }
            items={items}
            selectedKeys={selectedKeys}
            onSelect={select}
          />
        </DrawerPopoverContent>
      </DrawerPopover>
      {current && path ? (
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {path}
        </span>
      ) : null}
    </div>
  )
})
