import { createServerFn } from "@tanstack/react-start"
import { Effect } from "effect"
import {
  relayFileActivitySchema,
  relayFileContentSchema,
  relayDirectoryPageInputSchema,
  relayDirectoryPageSchema,
  relayFileSearchPageInputSchema,
  relayFileSearchPageSchema,
  relayFileEntrySchema,
  relayFileMutationInputSchema,
  relayFileMutationResultSchema,
  relayFileTreeSchema,
  relayConsoleCommandResultSchema,
  relayConsoleCommandSchema,
  relayConsoleCompletionInputSchema,
  relayConsoleCompletionSchema,
  relayInstanceActionSchema,
  relayInstanceNameSchema,
  relayInstancePortLeaseReleaseSchema,
  relayInstancePortLeaseRequestSchema,
  relayInstancePortLeaseSchema,
  relayInstancePortInputsSchema,
  relayInstanceResourceSnapshotSchema,
  relayInstanceWebRouteInputsSchema,
  relayInstanceWebRouteStateSchema,
  relayMclogsUploadResultSchema,
  relayIdSchema,
  relayInstanceSchema,
  relayControlDeadlineMs,
  relaySaveFileInputSchema,
  relaySnapshotSchema,
} from "@workspace/contracts"
import { z } from "zod"

import {
  allowedInstanceIds,
  hasPlatformPermission,
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
  visibleRelaysForUser,
} from "@/lib/access-control"
import {
  listFileActivity,
  recordFileEdited,
  recordFileViewed,
  setFilePinned,
} from "@/lib/file-activity"
import {
  instancePortsWritePermission,
  type AccessPermission,
} from "@/lib/permissions"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { requireAuthenticatedUser } from "@/server/auth"
import {
  AuthenticationError,
  ExternalServiceError,
  ResourceNotFoundError,
} from "@/effect/errors"
import { runAppEffect } from "@/effect/runtime"
import {
  applyManagedDomainAddressesEffect,
  provisionInstanceDomainBestEffort,
} from "@/server/domains.server"
import { syncInstanceDomainAfterPortUpdateBestEffort } from "@/server/relay-port-update.server"
import { deleteInstanceWithFinalBackup } from "@/lib/final-instance-deletion"
import {
  cachedRelayFallbackJsonEffect,
  cachedRelayJsonEffect,
  invalidateRelayCache,
  relayCachePolicy,
  relayFetchEffect,
  relayJsonEffect,
} from "@/lib/relay-client"
import type { RelayEndpoint } from "@/lib/relay-client"
import {
  relayInstanceRouteId,
  type RelayFleetSnapshot,
  type RelayReachability,
} from "@/lib/relay-fleet"
import type { PersistedRelay } from "@/lib/relay-registry"
import { listPersistedRelays } from "@/lib/relay-registry"
import { resolveMclogsApiUrl } from "@/lib/mclogs"

const instanceInputSchema = z.object({
  instanceId: z.string().min(1),
  relayId: relayIdSchema,
})

const treeInputSchema = instanceInputSchema.extend({
  fresh: z.boolean().optional(),
})

const fileStatInputSchema = instanceInputSchema.extend({
  path: z.string().min(1).max(8_192),
})

const directoryPageInputSchema = relayDirectoryPageInputSchema.extend({
  relayId: relayIdSchema,
})

const fileSearchPageInputSchema = relayFileSearchPageInputSchema.extend({
  relayId: relayIdSchema,
})

const instanceNameInputSchema = instanceInputSchema.extend({
  name: relayInstanceNameSchema,
})

const deleteInstanceInputSchema = instanceInputSchema.extend({
  confirmation: z.string().max(64),
  password: z.string().max(128),
})

const deleteInstanceResultSchema = z.object({
  deleted: z.literal(true),
  instanceId: z.string(),
})

const filePathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !path.startsWith("/") &&
      !path.split(/[\\/]/u).includes(".."),
    "Invalid relative file path"
  )

const fileInputSchema = instanceInputSchema.extend({ path: filePathSchema })

const filePinInputSchema = fileInputSchema.extend({ pinned: z.boolean() })

const saveFileInputSchema = fileInputSchema.extend(
  relaySaveFileInputSchema.shape
)

const fileMutationInputSchema = z.intersection(
  instanceInputSchema,
  relayFileMutationInputSchema
)

const actionInputSchema = instanceInputSchema.extend(
  relayInstanceActionSchema.shape
)

const webRoutesInputSchema = instanceInputSchema.extend({
  routes: relayInstanceWebRouteInputsSchema,
})

const portsInputSchema = instanceInputSchema.extend({
  ports: relayInstancePortInputsSchema,
})

const portLeaseInputSchema = instanceInputSchema.extend(
  relayInstancePortLeaseRequestSchema.omit({ overridePortRange: true }).shape
)

const portLeaseReleaseInputSchema = instanceInputSchema.extend(
  relayInstancePortLeaseReleaseSchema.shape
)

const consoleCommandInputSchema = instanceInputSchema.extend(
  relayConsoleCommandSchema.shape
)

const consoleCompletionInputSchema = instanceInputSchema.extend(
  relayConsoleCompletionInputSchema.shape
)

const consoleShareInputSchema = instanceInputSchema.extend({
  implementation: z.string().min(1),
  version: z.string().min(1),
  redactSensitive: z.boolean().default(false),
})

const mclogsUploadInputSchema = instanceInputSchema.extend({
  content: z
    .string()
    .min(1)
    .max(10 * 1024 * 1024),
  path: z.string().min(1),
  implementation: z.string().min(1),
  version: z.string().min(1),
})

const mclogsResponseSchema = z.object({
  success: z.literal(true),
  id: z.string(),
  url: z.url(),
  expires: z.number().int(),
})

const relayWarningIntervalMs = 60_000
const relayWarningAt = new Map<string, number>()

export const getRelaySnapshot = createServerFn({ method: "POST" }).handler(
  async () => {
    const user = await requireAuthenticatedUser()
    return authorizedFleetSnapshot(user, true)
  }
)

export const getRelayConnectionState = createServerFn({
  method: "GET",
}).handler(async () => {
  const user = await requireAuthenticatedUser()
  const configuredRelays = await authorizedRelays(
    user,
    await listPersistedRelays()
  )

  if (configuredRelays.length === 0) {
    return {
      status: "unconfigured" as const,
      message: "No Relay has been configured yet.",
      relay: null,
    }
  }

  const relays = configuredRelays.filter((relay) => relay.enabled)
  if (relays.length === 0) {
    return {
      status: "paused" as const,
      message: "All configured Relays are paused.",
      relay: publicPausedFleetRelay(configuredRelays),
      relays: configuredRelays.map((relay) =>
        publicRelayState({ relay, status: "paused" })
      ),
    }
  }

  const entries = await Promise.all(
    relays.map((relay) =>
      authorizedRelayEntry(relay, user, {
        fallbackOnError: true,
        warnOnUnavailable: true,
      })
    )
  )
  const connectedCount = entries.filter(
    (entry) => entry.status === "connected"
  ).length
  const snapshot = await mergeRelaySnapshots(entries)
  const relay = publicFleetRelay(relays, connectedCount)
  if (connectedCount === 0) {
    return {
      status: "unreachable" as const,
      message:
        relays.length === 1
          ? "The Relay is configured, but Hearth cannot reach it right now."
          : "Hearth cannot reach any configured Relay right now.",
      relay,
      relays: entries.map(publicRelayState),
    }
  }
  return {
    status: "connected" as const,
    relay,
    relays: entries.map(publicRelayState),
    snapshot,
  }
})

function warnRelayUnavailable(relayId: string, cause: unknown) {
  const now = Date.now()
  const lastWarning = relayWarningAt.get(relayId) ?? 0
  if (now - lastWarning < relayWarningIntervalMs) return
  relayWarningAt.set(relayId, now)
  console.warn(`[Kiln Relay] Could not reach Relay ${relayId}:`, cause)
}

export const updateInstanceName = createServerFn({ method: "POST" })
  .validator(instanceNameInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await instanceRelayAccess(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.settings",
      instanceId: data.instanceId,
    })
    const snapshot = relaySnapshotSchema.parse(
      await relayRequestRaw(relay, "/v1/snapshot")
    )
    const instance = snapshot.instances.find(
      (item) => item.id === data.instanceId
    )
    if (!instance) throw new Error("Instance not found")

    const renamed = relayInstanceSchema.parse(
      await relayRequestRaw(
        relay,
        `/v1/instances/${encodeURIComponent(instance.id)}`,
        {
          body: JSON.stringify({ name: data.name }),
          method: "PUT",
        },
        undefined,
        user.id
      )
    )
    await runAppEffect(
      "relay.snapshot.invalidate",
      invalidateRelayCache(relayCachePolicy.snapshot(relay.id))
    )
    return { ...renamed, relayId: relay.id }
  })

export const deleteInstance = createServerFn({ method: "POST" })
  .validator(deleteInstanceInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await instanceRelayAccess(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.delete",
      instanceId: data.instanceId,
    })
    if (data.confirmation !== data.instanceId) {
      throw AuthenticationError.make({
        message: "The server ID confirmation did not match.",
      })
    }
    const { requireAccountPassword } = await import("@/lib/auth-password")
    await requireAccountPassword(user, data.password)

    await deleteInstanceWithFinalBackup({
      instanceId: data.instanceId,
      relay,
      requestedBy: user.id,
    })
    return {
      ...deleteInstanceResultSchema.parse({
        deleted: true,
        instanceId: data.instanceId,
      }),
      relayId: relay.id,
    }
  })

export const sendRelayConsoleCommand = createServerFn({ method: "POST" })
  .validator(consoleCommandInputSchema)
  .handler(async ({ data }) => {
    const value = await relayRequest(
      `/v1/instances/${encodeURIComponent(data.instanceId)}/console`,
      {
        body: JSON.stringify({ command: data.command }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
      "instance.console.write",
      data.instanceId,
      data.relayId
    )
    return relayConsoleCommandResultSchema.parse(value)
  })

export const completeRelayConsoleCommand = createServerFn({ method: "POST" })
  .validator(consoleCompletionInputSchema)
  .handler(async ({ data }) => {
    const value = await relayRequest(
      `/v1/instances/${encodeURIComponent(data.instanceId)}/console-completions`,
      {
        body: JSON.stringify({ cursor: data.cursor, input: data.input }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
      "instance.console.read",
      data.instanceId,
      data.relayId
    )
    return relayConsoleCompletionSchema.parse(value)
  })

export const getInstanceWebRoutes = createServerFn({ method: "GET" })
  .validator(instanceInputSchema)
  .handler(async ({ data }) => {
    const value = await relayRequest(
      `/v1/instances/${encodeURIComponent(data.instanceId)}/web-routes`,
      undefined,
      "instance.network.read",
      data.instanceId,
      data.relayId
    )
    return relayInstanceWebRouteStateSchema.parse(value)
  })

export const getRelayInstanceResources = createServerFn({ method: "GET" })
  .validator(instanceInputSchema)
  .handler(async ({ data }) => {
    const value = await relayRequest(
      `/v1/instances/${encodeURIComponent(data.instanceId)}/resources`,
      undefined,
      "instance.read",
      data.instanceId,
      data.relayId
    )
    return relayInstanceResourceSnapshotSchema.parse(value)
  })

export const updateInstanceWebRoutes = createServerFn({ method: "POST" })
  .validator(webRoutesInputSchema)
  .handler(async ({ data }) => {
    const value = await relayRequest(
      `/v1/instances/${encodeURIComponent(data.instanceId)}/web-routes`,
      {
        body: JSON.stringify({ routes: data.routes }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      },
      "instance.network.write",
      data.instanceId,
      data.relayId,
      240_000
    )
    return relayInstanceWebRouteStateSchema.parse(value)
  })

export const updateInstancePorts = createServerFn({ method: "POST" })
  .validator(portsInputSchema)
  .handler(async ({ data }) => {
    const permission = instancePortsWritePermission(data.ports)
    const value = await relayRequest(
      `/v1/instances/${encodeURIComponent(data.instanceId)}/ports`,
      {
        body: JSON.stringify({ ports: data.ports }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      },
      permission,
      data.instanceId,
      data.relayId,
      240_000
    )
    const instance = relayInstanceSchema.parse(value)
    await syncInstanceDomainAfterPortUpdateBestEffort(
      instance,
      data.relayId,
      data.ports
    )
    await runAppEffect(
      "relay.snapshot.invalidate",
      invalidateRelayCache(relayCachePolicy.snapshot(data.relayId))
    )
    return { ...instance, relayId: data.relayId }
  })

export const reserveInstancePort = createServerFn({ method: "POST" })
  .validator(portLeaseInputSchema)
  .handler(async ({ data }) => {
    const permission =
      data.externalPort === undefined
        ? "instance.network.write"
        : "instance.network.public-port.write"
    const { relay, user } = await instanceRelayAccess(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission,
      instanceId: data.instanceId,
    })
    const response = await relayFetch(
      relay,
      `/v1/instances/${encodeURIComponent(data.instanceId)}/ports`,
      {
        body: JSON.stringify({
          externalPort: data.externalPort,
          leaseId: data.leaseId,
          overridePortRange: hasPlatformPermission(
            user,
            "platform.network.override-public-port-range"
          ),
          protocol: data.protocol,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
      undefined,
      user.id
    )
    const value = await response.json()
    return relayInstancePortLeaseSchema.parse(value)
  })

export const releaseInstancePort = createServerFn({ method: "POST" })
  .validator(portLeaseReleaseInputSchema)
  .handler(async ({ data }) => {
    await relayRequest(
      `/v1/instances/${encodeURIComponent(data.instanceId)}/ports`,
      {
        body: JSON.stringify({ leaseId: data.leaseId }),
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      },
      "instance.network.write",
      data.instanceId,
      data.relayId
    )
    return { released: true as const }
  })

export const getRelayTree = createServerFn({ method: "GET" })
  .validator(treeInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await instanceRelayAccess(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.files.read",
      instanceId: data.instanceId,
    })
    return runAppEffect(
      "relay.tree",
      cachedRelayJsonEffect({
        bypass: data.fresh,
        decode: relayFileTreeSchema.parse,
        fallbackOnError: !data.fresh,
        path: `/v1/instances/${encodeURIComponent(data.instanceId)}/tree`,
        policy: relayCachePolicy.tree(relay.id, data.instanceId),
        relay,
      })
    )
  })

export const getRelayDirectoryPage = createServerFn({ method: "GET" })
  .validator(directoryPageInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await instanceRelayAccess(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.files.read",
      instanceId: data.instanceId,
    })
    const search = new URLSearchParams({ path: data.path })
    if (data.cursor) search.set("cursor", data.cursor)
    return runAppEffect(
      "relay.directory",
      relayJsonEffect(
        relay,
        `/v1/instances/${encodeURIComponent(data.instanceId)}/directory?${search.toString()}`,
        relayDirectoryPageSchema.parse
      )
    )
  })

export const getRelayFileEntry = createServerFn({ method: "GET" })
  .validator(fileStatInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await instanceRelayAccess(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.files.read",
      instanceId: data.instanceId,
    })
    const search = new URLSearchParams({ path: data.path })
    return runAppEffect(
      "relay.fileStat",
      relayJsonEffect(
        relay,
        `/v1/instances/${encodeURIComponent(data.instanceId)}/file-stat?${search.toString()}`,
        relayFileEntrySchema.parse
      )
    )
  })

export const searchRelayFiles = createServerFn({ method: "GET" })
  .validator(fileSearchPageInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await instanceRelayAccess(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.files.read",
      instanceId: data.instanceId,
    })
    const search = new URLSearchParams({ query: data.query })
    if (data.cursor) search.set("cursor", data.cursor)
    return runAppEffect(
      "relay.fileSearch",
      relayJsonEffect(
        relay,
        `/v1/instances/${encodeURIComponent(data.instanceId)}/file-search?${search.toString()}`,
        relayFileSearchPageSchema.parse
      )
    )
  })

export const getRelayFile = createServerFn({ method: "GET" })
  .validator(fileInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await instanceRelayAccess(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.files.read",
      instanceId: data.instanceId,
    })
    const response = await relayFetch(
      relay,
      `/v1/instances/${encodeURIComponent(data.instanceId)}/file?path=${encodeURIComponent(data.path)}`
    )
    const file = relayFileContentSchema.parse(await response.json())
    await recordFileActivityBestEffort(
      "view",
      recordFileViewed(relay.id, data.instanceId, data.path)
    )
    return file
  })

export const saveRelayFile = createServerFn({ method: "POST" })
  .validator(saveFileInputSchema)
  .handler(async ({ data }) => {
    const { instanceId, path, relayId, ...input } = data
    const { relay, user } = await instanceRelayAccess(relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.files.write",
      instanceId,
    })
    const response = await relayFetch(
      relay,
      `/v1/instances/${encodeURIComponent(instanceId)}/file?path=${encodeURIComponent(path)}`,
      { method: "PUT", body: JSON.stringify(input) },
      undefined,
      user.id
    )
    const file = relayFileContentSchema.parse(await response.json())
    await recordFileActivityBestEffort(
      "edit",
      recordFileEdited(relay.id, instanceId, path)
    )
    return file
  })

export const mutateRelayFiles = createServerFn({ method: "POST" })
  .validator(fileMutationInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await instanceRelayAccess(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.files.write",
      instanceId: data.instanceId,
    })
    const input = relayFileMutationInputSchema.parse(data)
    const response = await relayFetch(
      relay,
      `/v1/instances/${encodeURIComponent(data.instanceId)}/file-mutations`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      undefined,
      user.id
    )
    const result = relayFileMutationResultSchema.parse(await response.json())
    await runAppEffect(
      "relay.tree.invalidate",
      invalidateRelayCache(relayCachePolicy.tree(relay.id, data.instanceId))
    )
    return result
  })

export const getRelayFileActivity = createServerFn({ method: "GET" })
  .validator(instanceInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await instanceRelayAccess(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.files.read",
      instanceId: data.instanceId,
    })
    return relayFileActivitySchema.parse(
      await listFileActivity(relay.id, data.instanceId)
    )
  })

export const updateRelayFilePin = createServerFn({ method: "POST" })
  .validator(filePinInputSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await instanceRelayAccess(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.files.write",
      instanceId: data.instanceId,
    })
    const search = new URLSearchParams({ path: data.path })
    const entry = await runAppEffect(
      "relay.fileStat.pinValidation",
      relayJsonEffect(
        relay,
        `/v1/instances/${encodeURIComponent(data.instanceId)}/file-stat?${search.toString()}`,
        relayFileEntrySchema.parse
      )
    )
    if (entry.kind !== "file" || entry.path !== data.path) {
      throw new Error("File not found")
    }
    const activity = await listFileActivity(relay.id, data.instanceId)
    const validPinnedPaths = await runAppEffect(
      "relay.fileStat.pinnedValidation",
      Effect.forEach(
        activity.files.filter((file) => file.pinned),
        (file) => {
          const pinnedSearch = new URLSearchParams({ path: file.path })
          return relayJsonEffect(
            relay,
            `/v1/instances/${encodeURIComponent(data.instanceId)}/file-stat?${pinnedSearch.toString()}`,
            relayFileEntrySchema.parse
          ).pipe(
            Effect.match({
              onFailure: () => null,
              onSuccess: (pinnedEntry) =>
                pinnedEntry.kind === "file" ? pinnedEntry.path : null,
            })
          )
        },
        { concurrency: 8 }
      )
    )
    const validPaths = new Set(
      validPinnedPaths.filter((path): path is string => path !== null)
    )
    validPaths.add(data.path)
    return relayFileActivitySchema.parse(
      await setFilePinned(
        relay.id,
        data.instanceId,
        data.path,
        data.pinned,
        validPaths
      )
    )
  })

export const performRelayAction = createServerFn({ method: "POST" })
  .validator(actionInputSchema)
  .handler(async ({ data }) => {
    const { instanceId, action } = data
    const { relay, user } = await instanceRelayAccess(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.power",
      instanceId,
    })
    const response = await relayFetch(
      relay,
      `/v1/instances/${encodeURIComponent(instanceId)}/actions`,
      { method: "POST", body: JSON.stringify({ action }) },
      relayControlDeadlineMs("instance.action"),
      user.id
    )
    const instance = relayInstanceSchema.parse(await response.json())
    if (action === "start" || action === "restart") {
      await provisionInstanceDomainBestEffort(instance, relay.id)
    }
    await runAppEffect(
      "relay.snapshot.invalidate",
      invalidateRelayCache(relayCachePolicy.snapshot(relay.id))
    )
    return { ...instance, relayId: relay.id }
  })

export const uploadToMclogs = createServerFn({ method: "POST" })
  .validator(mclogsUploadInputSchema)
  .handler(async ({ data }) => {
    await authorize("instance.logs.share", data.instanceId, data.relayId)
    return uploadLog(data)
  })

export const uploadConsoleLogToMclogs = createServerFn({ method: "POST" })
  .validator(consoleShareInputSchema)
  .handler(async ({ data }) => {
    return relayMclogsUploadResultSchema.parse(
      await relayRequest(
        `/v1/instances/${encodeURIComponent(data.instanceId)}/console-share`,
        {
          method: "POST",
          body: JSON.stringify({
            implementation: data.implementation,
            redactSensitive: data.redactSensitive,
            version: data.version,
          }),
        },
        "instance.logs.share",
        data.instanceId,
        data.relayId,
        60_000
      )
    )
  })

function uploadLog(data: z.infer<typeof mclogsUploadInputSchema>) {
  return runAppEffect("mclogs.upload", uploadLogEffect(data))
}

const uploadLogEffect = Effect.fn("mclogs.upload")(function* (
  data: z.infer<typeof mclogsUploadInputSchema>
) {
  const endpoint = resolveMclogsApiUrl(process.env.MCLOGS_API_URL)
  const timeout = AbortSignal.timeout(20_000)
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: data.content,
          source: "Kiln",
          metadata: [
            {
              key: "instance",
              label: "Instance",
              value: data.instanceId,
              visible: true,
            },
            {
              key: "software",
              label: "Software",
              value: `${data.implementation} ${data.version}`,
              visible: true,
            },
            {
              key: "path",
              label: "Source file",
              value: data.path,
              visible: true,
            },
          ],
        }),
        signal: timeout,
      }),
    catch: (cause) =>
      ExternalServiceError.make({
        service: "mclo.gs",
        message: timeout.aborted
          ? "mclo.gs upload timed out after 20 seconds"
          : `Could not upload to mclo.gs: ${errorMessage(cause)}`,
        cause,
      }),
  })

  const decodedPayload = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => cause,
  }).pipe(Effect.option)
  const payload = decodedPayload._tag === "Some" ? decodedPayload.value : null
  const errorPayload = z
    .object({ error: z.string().optional() })
    .nullable()
    .safeParse(payload)
  const responseMessage = errorPayload.success
    ? errorPayload.data?.error
    : undefined

  if (!response.ok) {
    return yield* ExternalServiceError.make({
      service: "mclo.gs",
      message: responseMessage ?? `mclo.gs returned HTTP ${response.status}`,
    })
  }

  const result = mclogsResponseSchema.safeParse(payload)
  if (!result.success) {
    return yield* ExternalServiceError.make({
      service: "mclo.gs",
      message: responseMessage ?? "mclo.gs returned an invalid response",
    })
  }
  return {
    id: result.data.id,
    url: result.data.url,
    expires: result.data.expires,
  }
})

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function recordFileActivityBestEffort(
  kind: "edit" | "view",
  operation: Promise<void>
): Promise<void> {
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => operation,
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          console.warn(
            `[Kiln Files] The ${kind} succeeded, but its recent-file activity could not be recorded:`,
            cause
          )
        })
      )
    )
  )
}

async function relayRequest(
  path: string,
  init: RequestInit | undefined,
  permission: AccessPermission,
  instanceId: string,
  relayId: string,
  timeoutMs?: number
): Promise<unknown> {
  const { relay, user } = await instanceRelayAccess(relayId)
  await requireRelayPermission({
    user,
    relayId: relay.id,
    permission,
    instanceId,
  })
  const response = await relayFetch(relay, path, init, timeoutMs, user.id)
  return response.json()
}

async function relayRequestRaw(
  relay: RelayEndpoint,
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
  subject?: string
): Promise<unknown> {
  return runAppEffect(
    "relay.json",
    relayJsonEffect(relay, path, (input) => input, init, timeoutMs, subject)
  )
}

async function relaySnapshot(relay: RelayEndpoint) {
  return runAppEffect(
    "relay.snapshot",
    cachedRelayJsonEffect({
      decode: relaySnapshotSchema.parse,
      path: "/v1/snapshot",
      policy: relayCachePolicy.snapshot(relay.id),
      relay,
    })
  )
}

async function relayFallbackSnapshot(relay: RelayEndpoint) {
  return runAppEffect(
    "relay.snapshotFallback",
    cachedRelayFallbackJsonEffect({
      decode: relaySnapshotSchema.parse,
      policy: relayCachePolicy.snapshot(relay.id),
    })
  )
}

async function authorizeRelaySnapshot(
  snapshot: Awaited<ReturnType<typeof relaySnapshot>>,
  relay: RelayEndpoint,
  user: AuthenticatedUser
) {
  const allowed = await allowedInstanceIds(
    user,
    relay.id,
    snapshot.instances.map((instance) => instance.id)
  )
  const instances = snapshot.instances.filter((item) => allowed.has(item.id))
  return {
    ...snapshot,
    instances,
  }
}

async function authorizedRelayEntry(
  relay: PersistedRelay,
  user: AuthenticatedUser,
  options: { fallbackOnError: boolean; warnOnUnavailable: boolean }
) {
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => relaySnapshot(relay),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((snapshot) => ({
        snapshot,
        status: "connected" as const,
      })),
      Effect.catch((cause) => {
        if (!options.fallbackOnError) return Effect.fail(cause)
        if (options.warnOnUnavailable) {
          warnRelayUnavailable(relay.id, cause)
        }
        return Effect.tryPromise({
          try: () => relayFallbackSnapshot(relay),
          catch: (fallbackCause) => fallbackCause,
        }).pipe(
          Effect.option,
          Effect.map((snapshot) => ({
            snapshot: snapshot._tag === "Some" ? snapshot.value : null,
            status: "unreachable" as const,
          }))
        )
      }),
      Effect.flatMap(({ snapshot, status }) =>
        Effect.tryPromise({
          try: async () => ({
            relay,
            snapshot: snapshot
              ? await authorizeRelaySnapshot(snapshot, relay, user)
              : null,
            status,
          }),
          catch: (cause) => cause,
        })
      )
    )
  )
}

async function relayFetch(
  relay: RelayEndpoint,
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
  subject?: string
): Promise<Response> {
  return runAppEffect(
    "relay.fetch",
    relayFetchEffect(relay, path, init, timeoutMs, subject)
  )
}

async function authorize(
  permission: AccessPermission,
  instanceId: string,
  relayId: string
) {
  const { relay, user } = await instanceRelayAccess(relayId)
  await requireRelayPermission({
    user,
    relayId: relay.id,
    permission,
    instanceId,
  })
}

async function instanceRelayAccess(relayId: string) {
  const user = await Effect.runPromise(
    Effect.tryPromise({
      try: requireAuthenticatedUser,
      catch: (cause) =>
        AuthenticationError.make({
          message: "Authentication required",
          cause,
        }),
    })
  )
  const relay = (await listPersistedRelays()).find(
    (item) => item.enabled && item.id === relayId
  )
  if (!relay) {
    throw ResourceNotFoundError.make({
      resource: "relay",
      message: "No Relay owns this instance",
    })
  }
  return { relay, user }
}

async function authorizedFleetSnapshot(
  user: AuthenticatedUser,
  fallbackOnError: boolean
): Promise<RelayFleetSnapshot> {
  const relays = (
    await authorizedRelays(user, await listPersistedRelays())
  ).filter((relay) => relay.enabled)
  const entries = await Promise.all(
    relays.map((relay) =>
      authorizedRelayEntry(relay, user, {
        fallbackOnError,
        warnOnUnavailable: false,
      })
    )
  )
  return mergeRelaySnapshots(entries)
}

async function authorizedRelays(
  user: AuthenticatedUser,
  relays: Array<PersistedRelay>
): Promise<Array<PersistedRelay>> {
  const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
  return visibleRelaysForUser(user, relays, grants)
}

async function mergeRelaySnapshots(
  entries: Array<{
    relay: PersistedRelay
    snapshot: Awaited<ReturnType<typeof authorizeRelaySnapshot>> | null
    status: RelayReachability
  }>
): Promise<RelayFleetSnapshot> {
  const instances = entries.flatMap(({ relay, snapshot, status }) =>
    (snapshot?.instances ?? []).map((instance) => ({
      ...instance,
      relayId: relay.id,
      relayName: relay.name,
      relayStatus: status,
    }))
  )
  const routedInstances = instances.map((instance) => ({
    ...instance,
    routeId: relayInstanceRouteId(instance.relayId, instance.shortId),
  }))
  const managedInstances = await runAppEffect(
    "domains.assignments.apply",
    applyManagedDomainAddressesEffect(routedInstances)
  )
  return {
    nodes: entries.flatMap(({ relay, snapshot, status }) =>
      snapshot
        ? [
            {
              ...snapshot.node,
              relayId: relay.id,
              relayName: relay.name,
              relayStatus: status,
            },
          ]
        : []
    ),
    instances: managedInstances,
  }
}

function publicFleetRelay(
  relays: Array<PersistedRelay>,
  connectedCount: number
) {
  const relay = relays[0]
  if (relays.length === 1 && relay) return { id: relay.id, name: relay.name }
  return {
    id: "relay-fleet",
    name: `${connectedCount}/${relays.length} Relays connected`,
  }
}

function publicPausedFleetRelay(relays: Array<PersistedRelay>) {
  const relay = relays[0]
  if (relays.length === 1 && relay) return { id: relay.id, name: relay.name }
  return {
    id: "relay-fleet",
    name: `${relays.length} Relays paused`,
  }
}

function publicRelayState<TStatus extends RelayReachability | "paused">(entry: {
  relay: PersistedRelay
  status: TStatus
}) {
  return {
    id: entry.relay.id,
    name: entry.relay.name,
    status: entry.status,
  }
}
