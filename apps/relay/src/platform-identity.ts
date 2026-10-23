/**
 * How a Relay in platform mode tells which container is its own, before it
 * joins that container to Kiln's network. Getting it wrong would attach
 * someone else's container, so every check fails closed.
 *
 * Docker bind-mounts each container's `/etc/hostname` from a folder named
 * after the container's ID. That alone isn't proof: a container started
 * with `--network container:<other>` gets the other container's hostname
 * file. So the candidate must also mount the Relay's data volume at the
 * Relay's data directory, which a container that only shares its network
 * doesn't.
 */

export interface MountIdentity {
  /** The ID in the folder `/etc/hostname` is mounted from. */
  readonly containerId: string | null
  /** Where the data directory is mounted from, as the kernel reports it. */
  readonly dataSource: string | null
}

/** Reads the Relay's identity evidence from `/proc/self/mountinfo`. */
export function mountIdentity(
  mountinfo: string,
  dataDirectory: string
): MountIdentity {
  let containerId: string | null = null
  let dataSource: string | null = null
  for (const line of mountinfo.split("\n")) {
    // id parent major:minor root mountpoint options ... - fstype source
    const [, , , root, mountPoint] = line.split(" ")
    if (!root || !mountPoint) continue
    if (mountPoint === "/etc/hostname") {
      containerId =
        /\/containers\/([0-9a-f]{64})\/hostname$/u.exec(root)?.[1] ?? null
    }
    if (mountPoint === dataDirectory) dataSource = root
  }
  return { containerId, dataSource }
}

interface CandidateContainer {
  readonly Id: string
  readonly Mounts?: ReadonlyArray<{
    readonly Destination: string
    readonly Source?: string
  }>
}

/**
 * Whether the candidate Docker reported for the identity's ID is this
 * Relay: the same ID, mounting the same data at the same directory.
 */
export function isOwnContainer(
  identity: MountIdentity,
  dataDirectory: string,
  candidate: CandidateContainer
): boolean {
  const { containerId, dataSource } = identity
  if (!containerId || candidate.Id !== containerId) return false
  // A root of `/` would match anything; real volume roots are deeper.
  if (!dataSource || dataSource === "/") return false
  return (candidate.Mounts ?? []).some(
    (mount) =>
      mount.Destination === dataDirectory &&
      mount.Source !== undefined &&
      // The kernel shows the path within its filesystem, which is a suffix
      // of Docker's when /var/lib/docker is a filesystem of its own.
      (mount.Source === dataSource || mount.Source.endsWith(dataSource))
  )
}
