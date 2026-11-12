import type { RelayVolume } from "@workspace/contracts"

/**
 * The volumes an App uses, as someone who can read only that App may
 * see them: nothing about the host, or about what else uses them.
 */
export function appVolumesOf(
  volumes: ReadonlyArray<RelayVolume>,
  appId: string
): Array<RelayVolume> {
  return volumes.flatMap((volume) => {
    if (!volume.users.some((user) => user.appId === appId)) return []
    return [
      {
        ...volume,
        mountpoint: null,
        mounts: volume.mounts.filter(
          (mount) => mount.kind === "app" && mount.resourceId === appId
        ),
        users: volume.users.filter((user) => user.appId === appId),
      },
    ]
  })
}
