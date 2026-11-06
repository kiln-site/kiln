// Whether what an App's containers mount is what it's set to mount. Docker
// can't change a running container's mounts, so a saved change waits for the
// next deploy, and this says so by comparing the two rather than remembering
// a save, so any deploy clears it.

/** What a container reports it mounts. */
export interface RunningMount {
  destination: string
  readOnly: boolean
  source: string
  type: string
}

export interface MountedContainer {
  mounts?: ReadonlyArray<RunningMount> | undefined
  service: string
}

export interface WantedMount {
  // Null where a container can't show it, such as a file's path on the node.
  readOnly: boolean | null
  // The service it's in, or null for every service.
  service: string | null
  source: string | null
  // A file's name on the node, which changes with its contents.
  sourceFile?: string | undefined
  target: string
}

// A name Docker chose: an anonymous volume, such as an image's VOLUME.
const ANONYMOUS_VOLUME = /^[a-f0-9]{64}$/u

const withoutTrailingSlash = (path: string) =>
  path.length > 1 ? path.replace(/\/+$/u, "") : path

/** Whether a Compose variable leaves it unknown until Compose reads it. */
const unresolved = (value: string | null) => value?.includes("$") === true

// Each service's newest container that reports its mounts; a deployment
// replacing one briefly runs two. Takes them newest first.
function newestByService(containers: ReadonlyArray<MountedContainer>) {
  const newest = new Map<string, ReadonlyArray<RunningMount>>()
  for (const { mounts, service } of containers) {
    if (mounts && !newest.has(service)) newest.set(service, mounts)
  }
  return newest
}

/**
 * Whether a mount has yet to reach a container that should have it. A
 * service with no container isn't running to compare, and an app with none
 * has nothing to apply it to.
 */
export function mountAwaitsDeploy(
  containers: ReadonlyArray<MountedContainer>,
  wanted: WantedMount
): boolean {
  if (unresolved(wanted.target)) return false
  const target = withoutTrailingSlash(wanted.target)
  for (const [service, mounts] of newestByService(containers)) {
    if (wanted.service !== null && wanted.service !== service) continue
    const running = mounts.find(
      (mount) => withoutTrailingSlash(mount.destination) === target
    )
    if (!running) return true
    if (wanted.readOnly !== null && wanted.readOnly !== running.readOnly) {
      return true
    }
    if (
      wanted.source !== null &&
      !unresolved(wanted.source) &&
      withoutTrailingSlash(wanted.source) !==
        withoutTrailingSlash(running.source)
    ) {
      return true
    }
    if (wanted.sourceFile) {
      const file = running.source.split("/").at(-1) ?? ""
      // Without a dash, it was deployed before names carried a version.
      if (file.includes("-") && file !== wanted.sourceFile) return true
    }
  }
  return false
}

/**
 * Whether a container still mounts something no longer wanted. Containers
 * mount things nobody set, so this counts only what can only have been set:
 * a named volume, or a bind outside a Compose file, which can bind its own
 * configs and secrets. A variable in a target leaves what's wanted unknown,
 * so nothing is said.
 */
export function mountsLeftBehind(
  containers: ReadonlyArray<MountedContainer>,
  wanted: ReadonlyArray<WantedMount>,
  { compose }: { compose: boolean }
): boolean {
  if (wanted.some(({ target }) => unresolved(target))) return false
  for (const [service, mounts] of newestByService(containers)) {
    const targets = new Set(
      wanted
        .filter((mount) => mount.service === null || mount.service === service)
        .map((mount) => withoutTrailingSlash(mount.target))
    )
    const left = mounts.some(
      ({ destination, source, type }) =>
        !targets.has(withoutTrailingSlash(destination)) &&
        (type === "volume"
          ? !ANONYMOUS_VOLUME.test(source)
          : type === "bind" && !compose)
    )
    if (left) return true
  }
  return false
}
