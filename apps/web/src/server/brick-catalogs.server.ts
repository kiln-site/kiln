import {
  brickReference,
  brickShownReference,
  brickSourceLineage,
  kilnBrickNamespace,
  type RelayCatalog,
} from "@workspace/contracts"

import {
  deleteBrickCatalogEffect,
  getBrickCatalogEffect,
  listBrickCatalogsEffect,
  saveBrickCatalogEffect,
  setBrickCatalogVisibilityEffect,
} from "@/effect/brick-catalogs"
import type { BrickCatalogRecord } from "@/effect/brick-catalogs"
import { hasPlatformPermission, isPlatformAdmin } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  hydrateBrickCatalogIcons,
  loadBrickCatalogSource,
  type LoadedBrickCatalog,
} from "@/lib/brick-catalog-source.server"
import { kilnBrickCatalogUrl, kilnGitRepository } from "@/lib/environment"
import { runAppEffect } from "@/effect/runtime"
import { promiseEffect, recoverPromise } from "@/effect/promise"
import { exclusive, partKey, shared } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import { Effect } from "effect"

const DEFAULT_CATALOG_ID = "default"
const DEFAULT_CACHE_TTL_MS = 5 * 60_000

export interface BrickCatalogSummary {
  author: string | null
  brickCount: number
  docs: string | null
  id: string
  isDefault: boolean
  name: string | null
  ownerEmail: string | null
  ownerName: string | null
  ownerUserId: string | null
  publishedAt: string | null
  revisionSha: string | null
  revisionUrl: string | null
  snapshotSha256: string | null
  source: string
  statusError: string | null
  support: string | null
  updatedAt: string | null
  visibility: "community" | "default" | "personal"
}

export async function listBrickCatalogsHandler() {
  const user = await requireEligibleResourceUser()
  const platformAdmin = isPlatformAdmin(user)
  const [defaultResult, records] = await Promise.all([
    loadDefaultCatalogResult(),
    runAppEffect(
      "brickCatalogs.list",
      listBrickCatalogsEffect(user.id, platformAdmin)
    ),
  ])
  return {
    catalogs: [
      defaultSummary(defaultResult.catalog, defaultResult.error),
      ...records.map((catalog) => catalogSummary(catalog, platformAdmin)),
    ],
    canAddCatalog: hasPlatformPermission(user, "platform.bricks.add-catalog"),
    isPlatformAdmin: platformAdmin,
    userId: user.id,
  }
}

export async function getBrickCatalogDetailsHandler(data: {
  catalogId: string
}) {
  const user = await requireEligibleResourceUser()
  if (data.catalogId === DEFAULT_CATALOG_ID) {
    const catalog = await loadDefaultCatalog()
    return {
      ...defaultSummary(catalog, null),
      bricks: (
        await hydrateBrickCatalogIcons(catalog.snapshot, {
          allowFile: catalog.snapshot.bricks.some((brick) =>
            brick.source.startsWith("file:")
          ),
          ...(catalog.source.startsWith("file:")
            ? { catalogUrl: new URL(catalog.source) }
            : {}),
        })
      ).bricks,
    }
  }
  const catalog = await requiredCatalog(data.catalogId)
  requireCatalogView(user, catalog)
  return {
    ...catalogSummary(catalog, isPlatformAdmin(user)),
    bricks: catalog.snapshot
      ? (await hydrateBrickCatalogIcons(catalog.snapshot)).bricks
      : [],
  }
}

// The lane keys catalogs take (docs/hearth-operations.md). A person's Brick
// library: adding to it, which can replace one of their catalogs, takes it
// exclusive; deleting or publishing one of their catalogs takes it shared,
// with the catalog whole to delete it or its `#visibility` to publish it.
const brickCatalogKey = (id: string) => `brick-catalog:${id}`
// A part, so everyday changes to one library wait for each other.
export const brickLibraryKey = (userId: string) =>
  partKey(`brick-library:${userId}`, "contents")
const libraryOf = (catalog: { ownerUserId: string | null }) =>
  catalog.ownerUserId ? [shared(brickLibraryKey(catalog.ownerUserId))] : []

// The catalog, and that this person may delete it: its owner, while it isn't
// published, or an administrator.
const deletableCatalog = (person: AuthenticatedUser, catalogId: string) =>
  promiseEffect(async () => {
    const catalog = await requiredCatalog(catalogId)
    if (!isPlatformAdmin(person) && catalog.ownerUserId !== person.id) {
      throw new Error("You do not have access to this catalog")
    }
    if (!isPlatformAdmin(person) && catalog.visibility === "community") {
      throw new Error("A platform admin must unpublish this catalog first")
    }
    return catalog
  })

// A Brick goes by its ID after whose it is (`brickReference`), so no two
// Bricks a person sees share both: one account's catalogs may each have a
// Brick, but not two by one ID. The same Brick in another copy of its
// catalog, read at another time, is one Brick. `beside` is every catalog
// that whoever sees this one sees too, but the copy it replaces.
function requireNamesFree(
  catalog: RelayCatalog,
  beside: ReadonlyArray<{ snapshot: RelayCatalog | null }>
): void {
  const own = kilnBrickNamespace(kilnGitRepository())
  const named = new Map<string, Map<string, string>>()
  for (const other of beside) {
    for (const brick of other.snapshot?.bricks ?? []) {
      const name = brickReference(brick, own)
      const lineages = named.get(name) ?? new Map<string, string>()
      lineages.set(
        brickSourceLineage(brick.source),
        other.snapshot?.name ?? "another catalog"
      )
      named.set(name, lineages)
    }
  }
  for (const brick of catalog.bricks) {
    const lineage = brickSourceLineage(brick.source)
    const [held] = [...(named.get(brickReference(brick, own)) ?? [])].filter(
      ([other]) => other !== lineage
    )
    if (held) {
      throw new Error(
        `${brickShownReference(brick, own)} is already in ${held[1]}. One owner's catalogs can't share a Brick ID.`
      )
    }
  }
}

// Kiln's own catalog, which everyone sees, when it can be read.
const kilnsCatalog = () =>
  recoverPromise(
    () => loadDefaultCatalog().then((catalog) => [catalog]),
    () => []
  )

// One at a time across every library: two catalogs added or published at
// once would each find the other's names free.
const brickNamesKey = partKey("brick-catalogs", "names")

const mayAddCatalog = (person: AuthenticatedUser) =>
  hasPlatformPermission(person, "platform.bricks.add-catalog")
const addingRefused = "Adding catalogs requires Bring your own Relay access"

const addCatalog = operation<{ readonly loaded: LoadedBrickCatalog }>()({
  name: "brickCatalog.add",
  doing: "Adding a Brick catalog",
  authorize: ({ user }) =>
    signedIn(user).pipe(
      Effect.filterOrFail(mayAddCatalog, () => new Error(addingRefused))
    ),
  locks: ({ context: person }) => [
    exclusive(brickLibraryKey(person.id)),
    exclusive(brickNamesKey),
  ],
  run: ({ context: person, input: { loaded } }) =>
    promiseEffect(async () => {
      // Beside what this person sees, but their own copy it replaces.
      requireNamesFree(loaded.snapshot, [
        ...(await kilnsCatalog()),
        ...(
          await runAppEffect(
            "brickCatalogs.visible",
            listBrickCatalogsEffect(person.id, false)
          )
        ).filter(
          (other) =>
            other.ownerUserId !== person.id || other.source !== loaded.source
        ),
      ])
      const catalogId = await runAppEffect(
        "brickCatalogs.save",
        saveBrickCatalogEffect({
          ownerUserId: person.id,
          revisionSha: loaded.revisionSha,
          revisionUrl: loaded.revisionUrl,
          snapshot: loaded.snapshot,
          snapshotSha256: loaded.snapshotSha256,
          source: loaded.source,
        })
      )
      return {
        ...catalogSummary(
          await requiredCatalog(catalogId),
          isPlatformAdmin(person)
        ),
        overlongBrickIds: loaded.overlongBrickIds,
      }
    }),
  audit: ({ context: person }) => ({ id: person.id, kind: "user" }),
})

export async function addBrickCatalogHandler(data: { source: string }) {
  const user = await requireEligibleResourceUser()
  // Read before it takes its turn: it holds the names every catalog goes
  // by, and a slow catalog would keep everyone else's waiting. Only for
  // someone who may add one, since reading it reaches out to its address.
  if (!mayAddCatalog(user)) throw new Error(addingRefused)
  return runOperationPromise(
    addCatalog,
    { loaded: await loadBrickCatalogSource(data.source) },
    { user }
  )
}

const deleteCatalog = operation<{ readonly catalogId: string }>()({
  name: "brickCatalog.delete",
  doing: "Deleting this Brick catalog",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.flatMap((person) => deletableCatalog(person, input.catalogId))
    ),
  locks: ({ context: catalog, input }) => [
    exclusive(brickCatalogKey(input.catalogId)),
    ...libraryOf(catalog),
  ],
  run: ({ input }) =>
    promiseEffect(async () => {
      await runAppEffect(
        "brickCatalogs.delete",
        deleteBrickCatalogEffect(input.catalogId)
      )
      return { deleted: true }
    }),
  audit: ({ input }) => ({ id: input.catalogId, kind: "brick-catalog" }),
})

export async function deleteBrickCatalogHandler(data: { catalogId: string }) {
  return runOperationPromise(deleteCatalog, data, {
    user: await requireEligibleResourceUser(),
  })
}

const publishCatalog = operation<{
  readonly catalogId: string
  readonly community: boolean
}>()({
  name: "brickCatalog.visibility",
  doing: "Publishing this Brick catalog",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.filterOrFail(
        isPlatformAdmin,
        () => new Error("Only platform admins can publish catalogs")
      ),
      Effect.flatMap((person) =>
        promiseEffect(() => requiredCatalog(input.catalogId)).pipe(
          Effect.map((catalog) => ({ catalog, person }))
        )
      )
    ),
  locks: ({ context: { catalog }, input }) => [
    exclusive(partKey(brickCatalogKey(input.catalogId), "visibility")),
    ...libraryOf(catalog),
    ...(input.community ? [exclusive(brickNamesKey)] : []),
  ],
  run: ({ context: { person }, input }) =>
    promiseEffect(async () => {
      const catalog = await requiredCatalog(input.catalogId)
      if (input.community && !catalog.snapshot) {
        throw new Error("Invalid catalog snapshots cannot be published")
      }
      // Published, everyone sees it beside what they already have: Kiln's
      // own catalog, the published ones, and each person's own.
      if (input.community && catalog.snapshot) {
        requireNamesFree(catalog.snapshot, [
          ...(await kilnsCatalog()),
          ...(
            await runAppEffect(
              "brickCatalogs.all",
              listBrickCatalogsEffect(person.id, true)
            )
          ).filter((other) => other.id !== catalog.id),
        ])
      }
      const updated = await runAppEffect(
        "brickCatalogs.setVisibility",
        setBrickCatalogVisibilityEffect({
          catalogId: input.catalogId,
          community: input.community,
          publishedBy: person.id,
        })
      )
      if (!updated) throw new Error("Catalog not found")
      return catalogSummary(await requiredCatalog(input.catalogId), true)
    }),
  audit: ({ input }) => ({ id: input.catalogId, kind: "brick-catalog" }),
})

export async function setBrickCatalogCommunityHandler(data: {
  catalogId: string
  community: boolean
}) {
  return runOperationPromise(publishCatalog, data, {
    user: await requireEligibleResourceUser(),
  })
}

/**
 * Kiln's own catalog, the one this installation is set up with, or null
 * while it can't be loaded.
 */
export async function defaultBrickCatalog() {
  const catalog = await recoverPromise(
    () => loadDefaultCatalog(),
    () => null
  )
  if (!catalog) return null
  return hydrateBrickCatalogIcons(catalog.snapshot, {
    allowFile: catalog.snapshot.bricks.some((brick) =>
      brick.source.startsWith("file:")
    ),
    ...(catalog.source.startsWith("file:")
      ? { catalogUrl: new URL(catalog.source) }
      : {}),
  })
}

export async function visibleBrickCatalogs(user: AuthenticatedUser) {
  const [defaultCatalog, records] = await Promise.all([
    recoverPromise(
      () => loadDefaultCatalog(),
      () => null
    ),
    runAppEffect(
      "brickCatalogs.visible",
      listBrickCatalogsEffect(user.id, false)
    ),
  ])
  return Promise.all(
    [
      ...(defaultCatalog ? [defaultCatalog.snapshot] : []),
      ...records.flatMap((record) =>
        record.snapshot ? [record.snapshot] : []
      ),
    ].map((catalog) =>
      hydrateBrickCatalogIcons(catalog, {
        allowFile: catalog.bricks.some((brick) =>
          brick.source.startsWith("file:")
        ),
        ...(defaultCatalog?.snapshot === catalog &&
        defaultCatalog.source.startsWith("file:")
          ? { catalogUrl: new URL(defaultCatalog.source) }
          : {}),
      })
    )
  )
}

async function requiredCatalog(catalogId: string): Promise<BrickCatalogRecord> {
  const catalog = await runAppEffect(
    "brickCatalogs.get",
    getBrickCatalogEffect(catalogId)
  )
  if (!catalog) throw new Error("Catalog not found")
  return catalog
}

function requireCatalogView(
  user: AuthenticatedUser,
  catalog: BrickCatalogRecord
): void {
  if (
    catalog.visibility !== "community" &&
    catalog.ownerUserId !== user.id &&
    !isPlatformAdmin(user)
  ) {
    throw new Error("You do not have access to this catalog")
  }
}

function catalogSummary(
  catalog: BrickCatalogRecord,
  includeOwnerDetails: boolean
): BrickCatalogSummary {
  return {
    author: catalog.snapshot?.author ?? null,
    brickCount: catalog.snapshot?.bricks.length ?? 0,
    docs: catalog.snapshot?.docs ?? null,
    id: catalog.id,
    isDefault: false,
    name: catalog.snapshot?.name ?? null,
    ownerEmail: includeOwnerDetails ? catalog.ownerEmail : null,
    ownerName: includeOwnerDetails ? catalog.ownerName : null,
    ownerUserId: catalog.ownerUserId,
    publishedAt: catalog.publishedAt,
    revisionSha: catalog.revisionSha,
    revisionUrl: catalog.revisionUrl,
    snapshotSha256: catalog.snapshotSha256,
    source: catalog.source,
    statusError: catalog.statusError,
    support: catalog.snapshot?.support ?? null,
    updatedAt: catalog.updatedAt,
    visibility: catalog.visibility,
  }
}

function defaultSummary(
  catalog: Awaited<ReturnType<typeof loadDefaultCatalog>> | null,
  error: string | null
): BrickCatalogSummary {
  return {
    author: catalog?.snapshot.author ?? null,
    brickCount: catalog?.snapshot.bricks.length ?? 0,
    docs: catalog?.snapshot.docs ?? null,
    id: DEFAULT_CATALOG_ID,
    isDefault: true,
    name: catalog?.snapshot.name ?? null,
    ownerEmail: null,
    ownerName: null,
    ownerUserId: null,
    publishedAt: null,
    revisionSha: catalog?.revisionSha ?? null,
    revisionUrl: catalog?.revisionUrl ?? null,
    snapshotSha256: catalog?.snapshotSha256 ?? null,
    source: catalog?.source ?? kilnBrickCatalogUrl(),
    statusError: error,
    support: catalog?.snapshot.support ?? null,
    updatedAt: null,
    visibility: "default",
  }
}

let defaultCatalogCache:
  | {
      expiresAt: number
      value: Awaited<ReturnType<typeof loadBrickCatalogSource>>
    }
  | undefined

async function loadDefaultCatalog() {
  if (defaultCatalogCache && defaultCatalogCache.expiresAt > Date.now()) {
    return defaultCatalogCache.value
  }
  return Effect.runPromise(
    promiseEffect(() =>
      loadBrickCatalogSource(kilnBrickCatalogUrl(), {
        allowFile: true,
        distributionRepository: process.env.KILN_BRICKS_CATALOG_URL?.trim()
          ? undefined
          : kilnGitRepository(),
      })
    ).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          defaultCatalogCache = {
            expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
            value,
          }
        })
      ),
      Effect.catch((cause) =>
        defaultCatalogCache
          ? Effect.succeed(defaultCatalogCache.value)
          : Effect.fail(cause)
      )
    )
  )
}

function loadDefaultCatalogResult() {
  return Effect.runPromise(
    promiseEffect(() => loadDefaultCatalog()).pipe(
      Effect.match({
        onFailure: (cause) => ({
          catalog: null,
          error:
            cause instanceof Error
              ? cause.message
              : "Default catalog is unavailable",
        }),
        onSuccess: (catalog) => ({ catalog, error: null }),
      })
    )
  )
}
