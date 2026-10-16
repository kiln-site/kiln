import { createServerFn, createServerOnlyFn } from "@tanstack/react-start"
import { relayIdSchema } from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import { kilnReleaseManifestEffect } from "@/effect/github-releases"
import {
  checkKilnReleasesEffect,
  listKilnReleasesEffect,
  recordComponentVersionsEffect,
  releaseHistoryPageEffect,
  releasesCheckedAtEffect,
} from "@/effect/kiln-release-feed"
import { PermissionDeniedError, RelayUnavailableError } from "@/effect/errors"
import { platformAdminIdsEffect } from "@/effect/notifications"
import { attachRelayOwnersEffect } from "@/effect/relay-owners"
import { runAppEffect } from "@/effect/runtime"
import {
  grantsAllowPermission,
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import { grantHasPermission } from "@/lib/permissions"
import type { PersistedRelay } from "@/lib/relay-registry"
import { listPersistedRelays } from "@/lib/relay-registry"
import {
  compareLatestReleaseVersion,
  findKilnRelease,
} from "@/lib/release-version"
import {
  updateTargetVersion,
  validateUpdateManifest,
} from "@/lib/update-manifest"
import { requireEligibleResourceUser } from "@/server/auth"
import { authorizedRelay } from "@/server/relay-access"

const componentSchema = z.enum(["hearth", "relay"])
const startUpdateTargetSchema = z.object({
  component: componentSchema,
  relayId: z.string().min(1).nullable(),
})
const startUpdatesSchema = z.object({
  // Names the updates this request starts, so the browser can find them in
  // the Relays' snapshots if the reply is lost.
  requestId: z.uuid().optional(),
  targets: z.array(startUpdateTargetSchema).min(1),
})
const releaseHistorySchema = z.object({
  cursor: z
    .object({
      publishedAt: z.number().int().nonnegative(),
      tag: z.string().min(1).max(191),
    })
    .nullable(),
})
// Updaters from before the Relays could be chosen send nothing, which reads
// them all; one may still be open while Hearth replaces itself.
const systemUpdatesSchema = z
  .object({
    // The Relays to read, or every one the user can update when null.
    relayIds: z.array(z.string().min(1)).max(500).nullable(),
  })
  .optional()
const updateStatusSchema = z.object({
  operationId: z.uuid(),
  relayId: z.string().min(1),
})
const systemInspectionSchema = z.object({
  component: componentSchema.nullable(),
  container: z.string().min(1),
  currentImage: z.string().min(1),
  currentVersion: z.string().nullable(),
  eligible: z.boolean(),
  installationId: z.string().nullable().optional().default(null),
  reason: z.string().nullable(),
  sameInstallation: z.boolean().optional().default(true),
})
const updateOperationSchema = z.object({
  component: componentSchema,
  error: z.string().nullable(),
  finishedAt: z.string().nullable(),
  id: z.uuid(),
  phase: z.string().optional(),
  previousImage: z.string(),
  requestedImage: z.string(),
  startedAt: z.string(),
  status: z.enum(["failed", "running", "succeeded"]),
  targetContainer: z.string(),
  version: z.string(),
})

const getContainerHostname = createServerOnlyFn(async () => {
  const { hostname } = await import("node:os")
  return hostname()
})

async function requireUpdateAccess() {
  return requireEligibleResourceUser()
}

async function updateRelaysForUser(
  user: Awaited<ReturnType<typeof requireEligibleResourceUser>>
): Promise<Array<PersistedRelay>> {
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  if (isPlatformAdmin(user)) return relays
  const grants = await listUserGrants(user.id)
  const allowed = new Set(
    grants.flatMap((grant) =>
      grant.resourceType === "relay" &&
      grantHasPermission(grant, "relay.update")
        ? [grant.relayId]
        : []
    )
  )
  return relays.filter((relay) => allowed.has(relay.id))
}

export const getUpdateOverview = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireUpdateAccess()
    const platformAdmin = isPlatformAdmin(user)
    const [releases, relays, container] = await Promise.all([
      runAppEffect("updates.releases", listKilnReleasesEffect()),
      updateRelaysForUser(user),
      platformAdmin ? getContainerHostname() : Promise.resolve(null),
    ])
    const enabledRelays = relays
    const { relayRpc } = await import("@/lib/relay-connection")

    const [relayTargets, hearthCandidates] = await Promise.all([
      Promise.all(
        enabledRelays.map((relay) =>
          Effect.runPromise(
            Effect.tryPromise({
              try: async () => {
                const inspection = systemInspectionSchema.parse(
                  await relayRpc(relay, "relay.system.inspect", {}, 5_000)
                )
                return {
                  ...inspection,
                  name: relay.name,
                  relayId: relay.id,
                  reachable: true as const,
                }
              },
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause) =>
                Effect.succeed({
                  component: "relay" as const,
                  container: "",
                  currentImage: "",
                  currentVersion: relay.nodeVersion,
                  eligible: false,
                  name: relay.name,
                  reachable: false as const,
                  reason:
                    cause instanceof Error
                      ? cause.message
                      : "Relay update support is unavailable",
                  relayId: relay.id,
                })
              )
            )
          )
        )
      ),
      platformAdmin && container
        ? Promise.all(
            enabledRelays.map((relay) =>
              Effect.runPromise(
                Effect.tryPromise({
                  try: async () => {
                    const inspection = systemInspectionSchema.parse(
                      await relayRpc(
                        relay,
                        "relay.system.inspect",
                        { container },
                        5_000
                      )
                    )
                    return inspection.component === "hearth" &&
                      inspection.sameInstallation
                      ? {
                          ...inspection,
                          relayId: relay.id,
                          relayName: relay.name,
                        }
                      : null
                  },
                  catch: (cause) => cause,
                }).pipe(
                  // A remote Relay cannot see Hearth's container and is skipped.
                  Effect.catch(() => Effect.succeed(null))
                )
              )
            )
          )
        : Promise.resolve([]),
    ])
    const hearthTarget = hearthCandidates.find((target) => target) ?? null
    const releasesCheckedAt = await runAppEffect(
      "updates.releases-checked-at",
      releasesCheckedAtEffect()
    )
    const currentVersion = import.meta.env.VITE_KILN_VERSION
    // Admins can update Relays other people brought, so those name who
    // paired them. Relays an admin paired are the platform's own and name
    // nobody. Like the Relays page, only admins see email-derived names.
    const [relaysWithOwners, adminIds] = await runAppEffect(
      "updates.relay-owners",
      Effect.all([
        attachRelayOwnersEffect(enabledRelays, platformAdmin),
        platformAdminIdsEffect(),
      ])
    )
    const admins = new Set(adminIds)
    const owners = new Map(
      relaysWithOwners.map((relay) => [
        relay.id,
        {
          ownedByViewer: relay.createdBy === user.id,
          ownerName:
            relay.createdBy && admins.has(relay.createdBy)
              ? null
              : relay.ownerName,
        },
      ])
    )
    // The versions each component ran before, so the changelog can show
    // where it came from. Recording them is best effort.
    const previousVersions = await runAppEffect(
      "updates.component-versions",
      recordComponentVersionsEffect([
        ...(platformAdmin
          ? [
              {
                key: "hearth",
                version: hearthTarget?.currentVersion ?? currentVersion,
              },
            ]
          : []),
        ...relayTargets.map((relay) => ({
          key: `relay:${relay.relayId}`,
          version: relay.currentVersion,
        })),
      ]).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not record component versions", error).pipe(
            Effect.as({} as Record<string, string>)
          )
        )
      )
    )

    return {
      canUpdateHearth: platformAdmin,
      currentVersion,
      hearth: hearthTarget,
      previousVersions,
      releases,
      // When Hearth last asked GitHub for releases.
      releasesCheckedAt,
      relays: relayTargets.map((relay) => ({
        ...relay,
        ownedByViewer: owners.get(relay.relayId)?.ownedByViewer ?? false,
        ownerName: owners.get(relay.relayId)?.ownerName ?? null,
      })),
    }
  }
)

/**
 * Asks GitHub for new Kiln releases now, for the updater's check button,
 * rather than waiting for Hearth's next check. `failed` says GitHub couldn't
 * be asked and the releases Hearth had are still shown.
 */
export const checkForKilnReleases = createServerFn({ method: "POST" }).handler(
  async () => {
    const user = await requireUpdateAccess()
    // Checks spend Hearth's GitHub requests, so only those who can update
    // something may ask for one.
    if (
      !isPlatformAdmin(user) &&
      (await updateRelaysForUser(user)).length === 0
    ) {
      throw PermissionDeniedError.make({
        message: "You don't have permission to update Kiln",
      })
    }
    return runAppEffect("updates.check-releases", checkKilnReleasesEffect())
  }
)

// The release this Relay runs, by name, and for those who can update it the
// newest release when it's newer, by the Updates dialog's rule. Either is
// null when unknown, as for development builds.
export const getRelayRelease = createServerFn({ method: "GET" })
  .validator(z.object({ relayId: relayIdSchema }))
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedRelay(data.relayId, "relay.read")
    const [{ relayConnectionNode }, grants, releases] = await Promise.all([
      import("@/lib/relay-connection"),
      isPlatformAdmin(user) ? null : listUserGrants(user.id, relay.id),
      runAppEffect("updates.relay-release", listKilnReleasesEffect()),
    ])
    const version = relayConnectionNode(relay.id)?.version ?? relay.nodeVersion
    const current = findKilnRelease(releases, version)
    const latest = releases[0]
    const canUpdate =
      grants === null ||
      grantsAllowPermission(grants, "relay.update", { relayId: relay.id })
    return {
      current: current ? { name: current.name, url: current.url } : null,
      update:
        canUpdate &&
        latest &&
        compareLatestReleaseVersion(version, releases) === 1
          ? { name: latest.name, url: latest.url, version: latest.version }
          : null,
    }
  })

export const getReleaseHistory = createServerFn({ method: "GET" })
  .validator(releaseHistorySchema)
  .handler(async ({ data }) => {
    await requireUpdateAccess()
    return runAppEffect(
      "updates.release-history",
      releaseHistoryPageEffect(data.cursor, releaseHistoryPageSize)
    )
  })

const releaseHistoryPageSize = 60

export const startSystemUpdates = createServerFn({ method: "POST" })
  .validator(startUpdatesSchema)
  .handler(async ({ data }) => {
    const user = await requireUpdateAccess()
    const platformAdmin = isPlatformAdmin(user)
    if (
      !platformAdmin &&
      data.targets.some((target) => target.component === "hearth")
    ) {
      throw new Error("Only a platform administrator can update Hearth")
    }
    const releases = await runAppEffect(
      "updates.latest-release",
      listKilnReleasesEffect()
    )
    const latestRelease = releases[0]
    if (!latestRelease) {
      throw new Error("No public Kiln release is available to install")
    }
    const [manifest, relays, { relayRpc }, hearthContainer] = await Promise.all(
      [
        runAppEffect(
          "updates.manifest",
          kilnReleaseManifestEffect(latestRelease.tag)
        ),
        updateRelaysForUser(user),
        import("@/lib/relay-connection"),
        data.targets.some(({ component }) => component === "hearth")
          ? getContainerHostname()
          : Promise.resolve(null),
      ]
    )
    const prepared = await Effect.runPromise(
      Effect.forEach(
        data.targets,
        (requested) =>
          Effect.tryPromise({
            try: async () => {
              validateUpdateManifest(
                manifest,
                latestRelease.version,
                requested.component
              )
              // Hearth's update runs on the Relay the browser was shown, so
              // that's the one it looks for the update on if the reply is
              // lost. The inspection below checks it can update Hearth.
              const relay =
                requested.component === "relay" || requested.relayId
                  ? await selectedRelay(relays, requested.relayId)
                  : await coLocatedRelay(
                      relays,
                      hearthContainer ?? "",
                      relayRpc
                    )
              const inspection = systemInspectionSchema.parse(
                await relayRpc(
                  relay,
                  "relay.system.inspect",
                  requested.component === "relay"
                    ? {}
                    : { container: hearthContainer },
                  15_000
                )
              )
              if (
                inspection.component !== requested.component ||
                !inspection.eligible
              ) {
                throw new Error(
                  inspection.reason ??
                    `This ${requested.component} container cannot be updated`
                )
              }
              return {
                component: requested.component,
                relay,
                targetContainer: inspection.container,
                targetImage: immutableImage(
                  manifest.components[requested.component]
                ),
              }
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.match({
              onFailure: (cause) => ({
                failure: {
                  component: requested.component,
                  message: errorMessage(cause),
                  outcomeUnknown: false,
                  relayId: requested.relayId,
                },
              }),
              onSuccess: (target) => ({ target }),
            })
          ),
        { concurrency: "unbounded" }
      )
    )
    const failures = prepared.flatMap((result) =>
      "failure" in result ? [result.failure] : []
    )
    const groups = new Map<
      string,
      {
        relay: PersistedRelay
        targets: Array<{
          component: "hearth" | "relay"
          targetContainer: string
          targetImage: string
        }>
      }
    >()
    for (const result of prepared) {
      if (!("target" in result)) continue
      const group = groups.get(result.target.relay.id) ?? {
        relay: result.target.relay,
        targets: [],
      }
      group.targets.push({
        component: result.target.component,
        targetContainer: result.target.targetContainer,
        targetImage: result.target.targetImage,
      })
      groups.set(result.target.relay.id, group)
    }

    const targetVersion = updateTargetVersion(manifest)
    const batchResults = await Effect.runPromise(
      Effect.forEach(
        groups.values(),
        (group) =>
          Effect.tryPromise({
            try: async () => {
              const currentUser = await requireEligibleResourceUser()
              if (currentUser.id !== user.id)
                throw new Error("The authenticated user changed")
              if (
                group.targets.some((target) => target.component === "hearth") &&
                !isPlatformAdmin(currentUser)
              ) {
                throw new Error(
                  "Only a platform administrator can update Hearth"
                )
              }
              await requireRelayPermission({
                user: currentUser,
                relayId: group.relay.id,
                permission: "relay.update",
              })
              const legacyTarget =
                group.targets.length === 1 ? group.targets[0] : undefined
              // This Hearth may be replaced before every Relay answers. Each
              // Relay still finishes what it accepted and reports it, named
              // by the request, in its snapshot, which the browser reads
              // back (getSystemUpdates).
              const operations = await runAppEffect(
                "updates.apply",
                Effect.tryPromise({
                  try: () =>
                    relayRpc(
                      group.relay,
                      "relay.update.apply",
                      {
                        helperImage: immutableImage(manifest.components.relay),
                        ...(data.requestId
                          ? { requestId: data.requestId }
                          : {}),
                        targets: group.targets.map((target) => ({
                          targetContainer: target.targetContainer,
                          targetImage: target.targetImage,
                          version: targetVersion,
                        })),
                        // A single target can also be understood by Relays from before
                        // batched updates, preserving the rolling upgrade path.
                        ...(legacyTarget
                          ? {
                              targetContainer: legacyTarget.targetContainer,
                              targetImage: legacyTarget.targetImage,
                              version: targetVersion,
                            }
                          : {}),
                      },
                      15 * 60_000,
                      user.id
                    ),
                  catch: (cause) => cause,
                }).pipe(
                  Effect.flatMap((response) =>
                    Effect.try({
                      try: () => parseUpdateOperations(response),
                      catch: (cause) => cause,
                    })
                  ),
                  Effect.mapError(
                    (cause) =>
                      new UpdateApplyError(
                        errorMessage(cause),
                        !relayAnsweredRequest(cause)
                      )
                  )
                )
              )
              return { group, operations }
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.match({
              onFailure: (cause) => ({
                failures: group.targets.map((target) => ({
                  component: target.component,
                  message: errorMessage(cause),
                  // The Relay may have started it; its snapshot will say.
                  outcomeUnknown:
                    cause instanceof UpdateApplyError && cause.outcomeUnknown,
                  relayId: target.component === "relay" ? group.relay.id : null,
                })),
                started: [],
              }),
              onSuccess: ({ group: successfulGroup, operations }) => ({
                failures: [],
                started: operations.map((operation) => ({
                  operation,
                  relayId: successfulGroup.relay.id,
                })),
              }),
            })
          ),
        { concurrency: "unbounded" }
      )
    )
    return {
      failures: [
        ...failures,
        ...batchResults.flatMap((result) => result.failures),
      ],
      started: batchResults.flatMap((result) => result.started),
    }
  })

export const getSystemUpdateStatus = createServerFn({ method: "POST" })
  .validator(updateStatusSchema)
  .handler(async ({ data }) => {
    const user = await requireUpdateAccess()
    const [relays, { relayRpc }] = await Promise.all([
      updateRelaysForUser(user),
      import("@/lib/relay-connection"),
    ])
    const relay = await selectedRelay(relays, data.relayId)
    const result = await relayRpc(
      relay,
      "relay.update.status",
      { operationId: data.operationId },
      15_000
    )
    if (result === null) return null
    const operation = updateOperationSchema.parse(result)
    return operation.component === "hearth" && !isPlatformAdmin(user)
      ? null
      : operation
  })

/**
 * The updates each Relay the user can update reported, running or finished;
 * Hearth's own only for platform administrators. `state` says whether they
 * are current (see `relayUpdateReportState`). The browser follows its
 * updates through them, so a Relay or Hearth that's away while it replaces
 * itself is waited for rather than failed, and finds the ones started by a
 * reply it lost or in another tab.
 */
export const getSystemUpdates = createServerFn({ method: "GET" })
  .validator(systemUpdatesSchema)
  .handler(async ({ data }) => {
    const user = await requireUpdateAccess()
    const platformAdmin = isPlatformAdmin(user)
    const [relays, { relayRpc, relaySystemUpdates, relayUpdateReportState }] =
      await Promise.all([
        updateRelaysForUser(user),
        import("@/lib/relay-connection"),
      ])
    const requested = data?.relayIds ? new Set(data.relayIds) : null
    const read = requested
      ? relays.filter((relay) => requested.has(relay.id))
      : relays
    // A Relay this process hasn't heard from yet is connected to now, so
    // its snapshot arrives. One that's away fails here and is reported as
    // unavailable.
    await Promise.allSettled(
      read.flatMap((relay) =>
        relayUpdateReportState(relay.id) === "unavailable"
          ? [relayRpc(relay, "relay.snapshot", {}, 5_000)]
          : []
      )
    )
    return read.map((relay) => ({
      name: relay.name,
      relayId: relay.id,
      state: relayUpdateReportState(relay.id),
      updates:
        relaySystemUpdates(relay.id)?.filter(
          (update) => platformAdmin || update.component === "relay"
        ) ?? [],
    }))
  })

export type SystemUpdateReports = Awaited<ReturnType<typeof getSystemUpdates>>

class UpdateApplyError extends Error {
  constructor(
    message: string,
    readonly outcomeUnknown: boolean
  ) {
    super(message)
  }
}

// The Relay answered with an error, so it didn't start the update. A lost
// connection or a timeout leaves that unknown.
function relayAnsweredRequest(cause: unknown): boolean {
  return (
    cause instanceof RelayUnavailableError &&
    cause.code !== undefined &&
    cause.code !== "request_cancelled"
  )
}

async function selectedRelay(
  relays: Array<PersistedRelay>,
  relayId: string | null
): Promise<PersistedRelay> {
  if (!relayId) throw new Error("Choose a Relay to update")
  const relay = relays.find((candidate) => candidate.id === relayId)
  if (!relay) throw new Error("Relay not found")
  return relay
}

async function coLocatedRelay(
  relays: Array<PersistedRelay>,
  container: string,
  relayRpc: typeof import("@/lib/relay-connection").relayRpc
): Promise<PersistedRelay> {
  const candidates = await Promise.all(
    relays.map((relay) =>
      Effect.runPromise(
        Effect.tryPromise({
          try: async () => {
            const inspection = systemInspectionSchema.parse(
              await relayRpc(
                relay,
                "relay.system.inspect",
                { container },
                5_000
              )
            )
            return inspection.component === "hearth" &&
              inspection.sameInstallation
              ? relay
              : null
          },
          catch: (cause) => cause,
        }).pipe(Effect.catch(() => Effect.succeed(null)))
      )
    )
  )
  const selected = candidates.find((relay) => relay)
  if (selected) return selected
  throw new Error(
    "Hearth updates require a paired Relay on the same Docker host"
  )
}

function immutableImage(component: { digest: string; image: string }): string {
  return `${component.image}@${component.digest}`
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Update could not start."
}

function parseUpdateOperations(value: unknown) {
  const batch = z.array(updateOperationSchema).safeParse(value)
  if (batch.success) return batch.data
  return [updateOperationSchema.parse(value)]
}

export type UpdateOverview = Awaited<ReturnType<typeof getUpdateOverview>>
