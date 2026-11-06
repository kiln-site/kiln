import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useMatch, useSearch } from "@tanstack/react-router"
import {
  appFileRootId,
  appVolumeFileRootId,
  type RelayVolume,
} from "@workspace/contracts"

import { appFilesAvailable } from "@/components/app/app-presentation"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
import { ResourceFilesPage } from "@/components/files/resource-files-page"
import {
  VolumeFileRootBar,
  type VolumeFileRoot,
} from "@/components/volumes/volume-file-roots"
import { appVolumesQueryOptions } from "@/lib/query-options"
import type { FileWorkspaceInstance } from "@/lib/relay-selectors"

// An app's folder on the Relay in the same file workspace servers use: a
// Dockerfile's build context and a pasted Compose file's project directory.
// Its containers don't mount it. Its volumes open in the same workspace,
// each as a root of its own.
export function AppFilesPage() {
  const { app, routeId } = useAppWorkspace()
  const filePath = useMatch({
    from: "/_app/app/$appId/files/$",
    shouldThrow: false,
    select: (match) => match.params._splat,
  })
  const volumeId =
    useSearch({
      from: "/_app/app/$appId/files",
      select: (search) => search.volume,
    }) ?? null
  const selectVolumes = React.useCallback(
    (data: {
      filesAvailable: boolean
      volumes: ReadonlyArray<RelayVolume>
    }): ReadonlyArray<VolumeFileRoot & { path: string }> =>
      data.filesAvailable ? appFileRoots(data.volumes, app.id, routeId) : [],
    [app.id, routeId]
  )
  const { data: volumes = noVolumes } = useQuery({
    ...appVolumesQueryOptions(app.relayId, app.id),
    refetchInterval: false,
    select: selectVolumes,
    staleTime: 5 * 60_000,
  })
  const current = volumes.find((volume) => volume.key === volumeId)
  const instance = React.useMemo<FileWorkspaceInstance>(
    () => ({
      id: volumeId
        ? appVolumeFileRootId(app.id, volumeId)
        : appFileRootId(app.id),
      implementation: "",
      name: current?.name ?? app.name,
      observedState: app.observedState,
      relayId: app.relayId,
      shortId: app.shortId,
      version: "",
    }),
    [
      app.id,
      app.name,
      app.observedState,
      app.relayId,
      app.shortId,
      current?.name,
      volumeId,
    ]
  )
  const route = React.useMemo(
    () => ({ id: routeId, kind: "app" as const }),
    [routeId]
  )
  const home = React.useMemo(
    () => ({
      link: { params: { appId: routeId }, to: "/app/$appId/files" } as const,
      name: "App folder",
    }),
    [routeId]
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <VolumeFileRootBar
        currentKey={volumeId}
        home={home}
        path={current?.path}
        relayId={app.relayId}
        volumes={volumes}
      />
      <ResourceFilesPage
        instance={instance}
        route={route}
        rootPath={volumeId ? (current?.path ?? "") : undefined}
        filePath={filePath}
        canWrite={app.permissions.includes("app.files.write")}
        connected={appFilesAvailable(app)}
      />
    </div>
  )
}

const noVolumes: ReadonlyArray<VolumeFileRoot & { path: string }> = []

// The volumes the app owns or uses, each with where the app mounts it.
function appFileRoots(
  volumes: ReadonlyArray<RelayVolume>,
  appId: string,
  routeId: string
): ReadonlyArray<VolumeFileRoot & { path: string }> {
  return volumes.flatMap((volume) =>
    volume.id !== null &&
    (volume.owner?.appId === appId ||
      volume.users.some((user) => user.appId === appId))
      ? [
          {
            dockerName: volume.dockerName,
            id: volume.id,
            key: volume.id,
            kind: volume.kind,
            link: {
              params: { appId: routeId },
              search: { volume: volume.id },
              to: "/app/$appId/files",
            } as const,
            name: volume.name,
            path:
              volume.mounts.find(
                (mount) => mount.kind === "app" && mount.resourceId === appId
              )?.destination ?? "",
            sizeBytes: volume.sizeBytes,
          },
        ]
      : []
  )
}
