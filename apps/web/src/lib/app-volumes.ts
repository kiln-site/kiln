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

/**
 * Whether a volume is one App's alone: a Kiln volume that App uses, which
 * no other App names or mounts and no other container mounts. Such a volume
 * can be deleted once its App is gone.
 */
export function appOwnsVolume(volume: RelayVolume, appId: string): boolean {
  return (
    volume.kind === "kiln" &&
    volume.id !== null &&
    volume.users.length > 0 &&
    volume.users.every((user) => user.appId === appId) &&
    volume.mounts.every(
      (mount) => mount.kind === "app" && mount.resourceId === appId
    )
  )
}
