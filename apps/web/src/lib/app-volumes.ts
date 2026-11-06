import type { RelayVolume } from "@workspace/contracts"

/**
 * The volumes an App owns or uses, as someone who can read only that App may
 * see them: nothing about the host, or about what else uses them.
 */
export function appVolumesOf(
  volumes: ReadonlyArray<RelayVolume>,
  appId: string
): Array<RelayVolume> {
  return volumes.flatMap((volume) => {
    const owned = volume.owner?.appId === appId
    if (!owned && !volume.users.some((user) => user.appId === appId)) return []
    return [
      {
        ...volume,
        mountpoint: null,
        mounts: volume.mounts.filter(
          (mount) => mount.kind === "app" && mount.resourceId === appId
        ),
        owner: owned ? volume.owner : null,
        users: volume.users.filter((user) => user.appId === appId),
      },
    ]
  })
}
