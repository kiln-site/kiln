import { createGunzip } from "node:zlib"
import { createWriteStream } from "node:fs"
import { chmod, lstat, mkdir, realpath, rm, symlink } from "node:fs/promises"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import type { RelayAppGitHubCheckout } from "@workspace/contracts"
import { Effect } from "effect"
import { extract as createTarExtractor, type ExtractEvents } from "tar-stream"

import {
  promiseEffect,
  recoverPromise,
  tapPromiseError,
} from "./effect/promise.js"

// A GitHub deployment's source: one commit of a repository, unpacked from
// the tarball GitHub serves for it. Only regular files, folders, and links
// that stay inside the checkout are kept, so nothing in a repository can
// write outside it or point a later read outside it.

const githubApiUrl = "https://api.github.com"
// Repositories larger than this don't belong in a build context.
export const MAX_CHECKOUT_BYTES = 2 * 1024 ** 3
export const MAX_CHECKOUT_ENTRIES = 200_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

type TarEntry = ExtractEvents["entry"][1]

export interface CheckoutSummary {
  files: number
  /** Links and special files left out. */
  skipped: number
}

/**
 * Downloads and unpacks `checkout`'s commit into `destination`, which must
 * not exist yet. A failed checkout leaves nothing behind.
 */
export async function checkOutRepository(
  checkout: Pick<RelayAppGitHubCheckout, "commit" | "repository" | "token">,
  destination: string,
  signal: AbortSignal
): Promise<CheckoutSummary> {
  // Cleaning up after a failure removes the folder, so it must be this
  // checkout's own.
  const exists = await recoverPromise(
    () => lstat(destination).then(() => true),
    () => false
  )
  if (exists) throw new Error("A checkout for this deployment already exists")
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  // GitHub answers with a redirect to a signed download, which fetch follows
  // without the token.
  const response = await fetch(
    `${githubApiUrl}/repos/${checkout.repository}/tarball/${checkout.commit}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${checkout.token}`,
        "User-Agent": "kiln-relay",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "follow",
      signal: AbortSignal.any([signal, timeout]),
    }
  )
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(downloadFailure(response.status))
  }
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (declared > MAX_CHECKOUT_BYTES) {
    await response.body.cancel()
    throw new Error("The repository is larger than 2 GiB")
  }
  const body = response.body
  return Effect.runPromise(
    promiseEffect(() =>
      extractRepositoryArchive(
        Readable.fromWeb(body as never),
        destination,
        signal
      )
    ).pipe(
      Effect.tapError(() =>
        promiseEffect(() =>
          rm(destination, { force: true, recursive: true })
        ).pipe(Effect.ignore)
      )
    )
  )
}

/**
 * Unpacks a gzipped tarball whose entries all sit under one top folder, as
 * GitHub's do, into `destination` without that folder.
 */
export async function extractRepositoryArchive(
  source: Readable,
  destination: string,
  signal: AbortSignal
): Promise<CheckoutSummary> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  // Its folders, top one included, are readable by every user, as a
  // repository's are, so a container running as any user can read files
  // bound from it. The folders above it stay private.
  await mkdir(destination, { mode: 0o755 })
  await chmod(destination, 0o755)
  const root = await realpath(destination)
  const extractor = createTarExtractor()
  const links: Array<{ path: string; target: string }> = []
  const summary: CheckoutSummary = { files: 0, skipped: 0 }
  let entries = 0
  let bytes = 0
  // Set only for what went wrong unpacking, rather than reading, an entry.
  let failure: unknown = null
  const unpack = async (entry: TarEntry) => {
    if (signal.aborted) throw new Error("The deployment was cancelled")
    entries += 1
    if (entries > MAX_CHECKOUT_ENTRIES) {
      throw new Error("The repository has more than 200,000 files")
    }
    const { header } = entry
    const path = checkoutPath(root, header.name)
    const type = header.type ?? "file"
    if (type === "directory") {
      // The top folder itself has no path of its own.
      if (path !== null) await makeFolders(root, path)
    } else if (path !== null && type === "file") {
      bytes += header.size ?? 0
      if (bytes > MAX_CHECKOUT_BYTES) {
        throw new Error("The repository is larger than 2 GiB")
      }
      await makeFolders(root, dirname(path))
      // Executable files stay executable; nothing else carries over.
      const mode = 0o644 | ((header.mode ?? 0) & 0o111)
      await pipeline(entry, createWriteStream(path, { flags: "wx", mode }), {
        signal,
      })
      // Set again past the umask, so any container user can read it.
      await chmod(path, mode)
      summary.files += 1
      return
    } else if (path !== null && type === "symlink" && header.linkname) {
      // Links are made last, so no file is written through one.
      links.push({ path, target: header.linkname })
    } else {
      summary.skipped += 1
    }
    for await (const _chunk of entry) {
      if (signal.aborted) throw new Error("The deployment was cancelled")
    }
  }
  const unpacked = (async () => {
    for await (const entry of extractor) {
      await tapPromiseError(
        () => unpack(entry),
        (cause) => {
          failure = cause
          // Stops the download too, which would otherwise wait for this
          // reader.
          extractor.destroy(cause instanceof Error ? cause : undefined)
        }
      )
    }
  })()
  const [stream, unpackedAll] = await Promise.allSettled([
    pipeline(source, createGunzip(), extractor, { signal }),
    unpacked,
  ])
  if (failure !== null) throw failure
  if (stream.status === "rejected" || unpackedAll.status === "rejected") {
    if (signal.aborted) throw new Error("The deployment was cancelled")
    throw new Error("The repository's archive could not be read", {
      cause:
        stream.status === "rejected"
          ? stream.reason
          : unpackedAll.status === "rejected"
            ? unpackedAll.reason
            : undefined,
    })
  }
  summary.skipped += await createContainedLinks(root, links)
  return summary
}

// Makes each folder from the checkout down to `path` that doesn't exist,
// readable by every user whatever the umask. No links exist yet, so none is
// followed.
async function makeFolders(root: string, path: string): Promise<void> {
  let folder = root
  for (const segment of relative(root, path).split(sep)) {
    if (!segment) continue
    folder = join(folder, segment)
    const made = await recoverPromise(
      () => mkdir(folder, { mode: 0o755 }).then(() => true),
      () => false
    )
    if (made) await chmod(folder, 0o755)
  }
}

// Makes the links whose folders are inside the checkout and that lead to
// something inside it, checked on disk, since a chain of links that each
// look inside can lead out. A link may lead through others in any order, so
// they're made in rounds, then any that dangle or lead out are removed until
// none do. Returns how many were left out.
async function createContainedLinks(
  root: string,
  links: ReadonlyArray<{ path: string; target: string }>
): Promise<number> {
  let pending = links.filter((link) => !isAbsolute(link.target))
  const placed: Array<string> = []
  for (let round = 0; round <= links.length && pending.length > 0; round += 1) {
    const waiting: typeof pending = []
    for (const link of pending) {
      // Its folder may be a link a later round makes.
      const folder = await recoverPromise(
        () => realpath(dirname(link.path)),
        () => null
      )
      if (!folder || !contained(root, folder)) {
        waiting.push(link)
        continue
      }
      const path = join(folder, basename(link.path))
      if (!contained(root, resolve(folder, link.target))) continue
      const created = await recoverPromise(
        () => symlink(link.target, path).then(() => true),
        () => false
      )
      if (created) placed.push(path)
    }
    if (waiting.length === pending.length) break
    pending = waiting
  }
  // Removing one can leave another dangling, so this repeats until none
  // dangle or lead out.
  let kept = placed
  for (;;) {
    const next: Array<string> = []
    for (const path of kept) {
      const leadsTo = await recoverPromise(
        () => realpath(path),
        () => null
      )
      if (leadsTo && contained(root, leadsTo)) next.push(path)
      else await rm(path, { force: true })
    }
    if (next.length === kept.length) break
    kept = next
  }
  return links.length - kept.length
}

/**
 * A file the checkout holds, by its path in the repository, or null if it
 * doesn't, or is a link that leads outside it.
 */
export async function checkoutFile(
  root: string,
  path: string
): Promise<string | null> {
  const candidate = resolve(root, path)
  if (!contained(root, candidate)) return null
  const resolved = await recoverPromise(
    () => realpath(candidate),
    () => null
  )
  if (!resolved || !contained(await realpath(root), resolved)) return null
  const stats = await lstat(resolved)
  return stats.isFile() ? resolved : null
}

// Where an entry lands without the archive's top folder, or null when it
// would land outside the checkout or is the top folder itself.
function checkoutPath(root: string, name: string): string | null {
  const segments = name.replace(/\\/gu, "/").split("/")
  if (
    name.startsWith("/") ||
    segments.some((segment) => segment === ".." || segment.includes("\0"))
  ) {
    return null
  }
  // GitHub's top folder is owner-repo-sha.
  const inner = segments
    .slice(1)
    .filter((segment) => segment !== "" && segment !== ".")
  if (inner.length === 0) return null
  const path = resolve(root, ...inner)
  return contained(root, path) && path !== root ? path : null
}

function contained(root: string, path: string): boolean {
  const offset = relative(root, path)
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset))
}

function downloadFailure(status: number): string {
  if (status === 401 || status === 403) {
    return "GitHub refused the download; check the source can read this repository"
  }
  if (status === 404) {
    return "GitHub couldn't find that commit, or the source can't read the repository"
  }
  return `GitHub couldn't send the repository (HTTP ${status})`
}

/** The checkout's folder in a Relay's data directory. */
export function checkoutDirectory(
  dataDirectory: string,
  appId: string,
  deploymentId: string
): string {
  return join(dataDirectory, "app-sources", appId, deploymentId)
}
