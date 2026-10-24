/**
 * Where a process in a Docker container finds its container's ID: a Relay
 * in platform mode before it proves the container is itself and joins it to
 * Kiln's network, and Hearth before it proves its container to its Relays.
 *
 * Docker bind-mounts each container's `/etc/hostname` from a folder named
 * after the container's ID. That's only a candidate: a container started
 * with `--network container:<other>` gets the other container's hostname
 * file, so the candidate still has to be proven.
 */
export function hostnameContainerId(mountinfo: string): string | null {
  for (const line of mountinfo.split("\n")) {
    // id parent major:minor root mountpoint options ... - fstype source
    const [, , , root, mountPoint] = line.split(" ")
    if (mountPoint !== "/etc/hostname" || !root) continue
    return /\/containers\/([0-9a-f]{64})\/hostname$/u.exec(root)?.[1] ?? null
  }
  return null
}
