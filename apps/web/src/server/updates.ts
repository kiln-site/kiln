import { createServerFn, createServerOnlyFn } from "@tanstack/react-start"
import { Effect } from "effect"
import { z } from "zod"

import {
  kilnReleaseManifestEffect,
  listKilnReleasesEffect,
} from "@/effect/github-releases"
import { runAppEffect } from "@/effect/runtime"
import {
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import { grantHasPermission } from "@/lib/permissions"
import type { PersistedRelay } from "@/lib/relay-registry"
import { listPersistedRelays } from "@/lib/relay-registry"
import {
  updateTargetVersion,
  validateUpdateManifest,
} from "@/lib/update-manifest"
import { requireEligibleResourceUser } from "@/server/auth"

const componentSchema = z.enum(["hearth", "relay"])
const startUpdateTargetSchema = z.object({
  component: componentSchema,
  relayId: z.string().min(1).nullable(),
})
const startUpdatesSchema = z.object({
  targets: z.array(startUpdateTargetSchema).min(1),
})
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

    return {
      canUpdateHearth: platformAdmin,
      currentVersion: import.meta.env.VITE_KILN_VERSION,
      hearth: hearthTarget,
      releases,
      relays: relayTargets,
    }
  }
)

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
              const relay =
                requested.component === "relay"
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
              const response = await relayRpc(
                group.relay,
                "relay.update.apply",
                {
                  helperImage: immutableImage(manifest.components.relay),
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
              )
              return {
                group,
                operations: parseUpdateOperations(response),
              }
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.match({
              onFailure: (cause) => ({
                failures: group.targets.map((target) => ({
                  component: target.component,
                  message: errorMessage(cause),
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
