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
export const brickLibraryKey = (userId: string) => `brick-library:${userId}`
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

const addCatalog = operation<{ readonly source: string }>()({
  name: "brickCatalog.add",
  doing: "Adding a Brick catalog",
  authorize: ({ user }) =>
    signedIn(user).pipe(
      Effect.filterOrFail(
        (person) =>
          hasPlatformPermission(person, "platform.bricks.add-catalog"),
        () => new Error("Adding catalogs requires Bring your own Relay access")
      )
    ),
  locks: ({ context: person }) => [exclusive(brickLibraryKey(person.id))],
  run: ({ context: person, input }) =>
    promiseEffect(async () => {
      const loaded = await loadBrickCatalogSource(input.source)
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
  return runOperationPromise(addCatalog, data, {
    user: await requireEligibleResourceUser(),
  })
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
  ],
  run: ({ context: { person }, input }) =>
    promiseEffect(async () => {
      const catalog = await requiredCatalog(input.catalogId)
      if (input.community && !catalog.snapshot) {
        throw new Error("Invalid catalog snapshots cannot be published")
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
