import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useMatch } from "@tanstack/react-router"
import type { RelayVolume } from "@workspace/contracts"

import { ResourceFilesPage } from "@/components/files/resource-files-page"
import {
  VolumeFileRootBar,
  type VolumeFileRoot,
} from "@/components/volumes/volume-file-roots"
import {
  HostFilesLimitation,
  RelayHostFilesAccess,
} from "@/components/relay/relay-host-access"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import { canAccessRelayPermission } from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  relayVolumesQueryOptions,
} from "@/lib/query-options"
import type { FileWorkspaceInstance } from "@/lib/relay-selectors"
import { warmFileWorkspaceModule } from "@/lib/workspace-module-preloads"

export function RelayFilesPage() {
  React.useEffect(warmFileWorkspaceModule, [])
  const { relay, routeId } = useRelayWorkspace()
  const { connected } = useRelayLiveStatus(relay)
  const filePath = useMatch({
    from: "/_app/relay/$relayId/files/$",
    shouldThrow: false,
    select: (match) => match.params._splat,
  })
  const { data: canWrite = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) =>
      canAccessRelayPermission(capabilities, relay.id, "relay.files.write"),
  })
  const instance = React.useMemo<FileWorkspaceInstance>(
    () => ({
      id: relay.id,
      name: relay.name,
      relayId: relay.id,
      shortId: relay.id.slice(0, 8),
      implementation: "",
      version: "",
      observedState: "running",
    }),
    [relay.id, relay.name]
  )
  const route = React.useMemo(
    () => ({ kind: "relay" as const, id: routeId }),
    [routeId]
  )
  const selectVolumes = React.useCallback(
    (data: { volumes: ReadonlyArray<RelayVolume> }) =>
      hostVolumeRoots(data.volumes, routeId),
    [routeId]
  )
  const { data: volumes = noVolumes } = useQuery({
    ...relayVolumesQueryOptions(relay.id),
    refetchInterval: false,
    select: selectVolumes,
    staleTime: 5 * 60_000,
  })
  const home = React.useMemo(
    () => ({
      link: {
        params: { relayId: routeId },
        to: "/relay/$relayId/files",
      } as const,
      name: "Host files",
    }),
    [routeId]
  )
  const openPath = `/${filePath ?? ""}/`.replace(/\/+/gu, "/")
  const current = volumes.find((volume) =>
    openPath.startsWith(`${volume.key}/`)
  )
  return (
    <RelayHostFilesAccess>
      {(limitation) => (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {limitation ? <HostFilesLimitation limitation={limitation} /> : null}
          <VolumeFileRootBar
            currentKey={current?.key ?? null}
            home={home}
            path={current?.key}
            relayId={relay.id}
            volumes={volumes}
          />
          <ResourceFilesPage
            instance={instance}
            route={route}
            filePath={filePath}
            canWrite={canWrite && limitation !== "read-only"}
            connected={connected}
          />
        </div>
      )}
    </RelayHostFilesAccess>
  )
}

const noVolumes: ReadonlyArray<VolumeFileRoot> = []

// A Relay's volumes are folders in its host files, keyed by where they are.
function hostVolumeRoots(
  volumes: ReadonlyArray<RelayVolume>,
  routeId: string
): ReadonlyArray<VolumeFileRoot> {
  return volumes.flatMap((volume) =>
    volume.mountpoint
      ? [
          {
            dockerName: volume.dockerName,
            id: volume.id,
            key: volume.mountpoint,
            kind: volume.kind,
            link: {
              params: {
                _splat: `${volume.mountpoint.replace(/^\/+/u, "")}/`,
                relayId: routeId,
              },
              to: "/relay/$relayId/files/$",
            } as const,
            name: volume.name,
            sizeBytes: volume.sizeBytes,
          },
        ]
      : []
  )
}
