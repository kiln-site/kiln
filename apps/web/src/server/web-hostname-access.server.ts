import { relayCertificateCheckResultSchema } from "@workspace/contracts"
import { Effect } from "effect"

import { DomainConfigurationError, HostnameInUseError } from "@/effect/errors"
import { promiseEffect, recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import {
  listResourceWebHostnamesEffect,
  loadWebHostnameEffect,
  markResourceAddressesRemovingEffect,
  webHostnameProxied,
  type WebHostnameResource,
} from "@/effect/addresses"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { dnsKey } from "@/lib/dns-operations"
import { relayRpc } from "@/lib/relay-connection"
import { activeRelay } from "@/lib/relay-registry"
import { exclusive, resourceKey, shared } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import { domainActor } from "@/server/domain-access.server"
import {
  explainHostnameInUseEffect,
  requireResourcePermission,
} from "@/server/domain-resource-access.server"
import type {
  AdoptWebHostnameRecordInput,
  CheckWebCertificateInput,
  ResourceWebHostnames,
  ResourceWebHostnamesInput,
  WebCertificateCheck,
} from "@/server/domains"
import {
  certificateState,
  pendingWebCertificates,
} from "@/server/web-certificates.server"
import {
  adoptableWebHostnamesEffect,
  adoptExistingWebRecordEffect,
  deleteResourceAddressesEffect,
  generateAppHostnameEffect,
  publishWebHostnameChange,
  reconcileResourceAddressesEffect,
  saveWebRouteHostnamesEffect,
  type WebHostnameProxyChange,
} from "@/server/addresses.server"

/** A game server's or app's web hostnames, for its network page. */
export async function getResourceWebHostnamesHandler(
  data: ResourceWebHostnamesInput
): Promise<ResourceWebHostnames> {
  const user = await requireEligibleResourceUser()
  await requireResourcePermission(user, data, false)
  const canChange = await recoverPromise(
    () => requireResourcePermission(user, data, true).then(() => true),
    () => false
  )
  const rows = await runAppEffect(
    "webHostnames.resource",
    listResourceWebHostnamesEffect(data)
  )
  const adoptable = canChange
    ? await runAppEffect(
        "webHostnames.adoptable",
        adoptableWebHostnamesEffect(rows, domainActor(user))
      )
    : new Map<string, boolean>()
  return {
    canChange,
    certificates: pendingWebCertificates(data),
    hostnames: rows.map((row) => ({
      canAdopt: adoptable.has(row.id),
      // Only an address of its own that no route uses.
      canRelease: canChange && row.standalone && !row.routed,
      // Only to someone who can take it over: what's at the name otherwise
      // isn't this page's to show.
      existingRecord: adoptable.has(row.id) ? row.existingRecord : null,
      generated: row.standalone,
      hostname: row.hostname,
      id: row.id,
      lastError: row.lastError,
      pointsAtRelay: adoptable.get(row.id) ?? false,
      primary: row.standalone && row.primary,
      proxied: webHostnameProxied(row),
      status: row.status,
    })),
  }
}

// The Relay orders it; holding the resource shared lets a deletion turn it away.
const checkCertificate = operation<CheckWebCertificateInput>()({
  name: "webHostname.certificate.check",
  doing: "Checking its certificate",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.flatMap((person) =>
        promiseEffect(() => requireResourcePermission(person, input, true))
      )
    ),
  locks: ({ input }) => [
    shared(resourceKey(input.resourceType, input.relayId, input.resourceId)),
  ],
  run: ({ input, user }) =>
    promiseEffect(async (): Promise<WebCertificateCheck> => {
      const { asked, pending } = relayCertificateCheckResultSchema.parse(
        await relayRpc(
          await activeRelay(input.relayId),
          "relay.certificates.check",
          {
            hostname: input.hostname,
            // The Relay refuses a hostname this resource's routes don't serve.
            owner: {
              id: input.resourceId,
              kind: input.resourceType === "app" ? "app" : "server",
            },
          },
          30_000,
          user?.id
        )
      )
      return { asked, certificate: pending ? certificateState(pending) : null }
    }),
})

/** Has the hostname's Relay check it now and ask for its certificate again. */
export async function checkWebCertificateHandler(
  data: CheckWebCertificateInput
): Promise<WebCertificateCheck> {
  return runOperationPromise(checkCertificate, data, {
    user: await requireEligibleResourceUser(),
  })
}

// Taking over a record changes its game server's or App's DNS, so it holds
// that `#dns`. It also takes owning the domain's Cloudflare connection,
// which the change checks.
const adoptRecord = operation<AdoptWebHostnameRecordInput>()({
  name: "webHostname.adopt",
  doing: "Taking over its DNS record",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.flatMap((person) =>
        Effect.gen(function* () {
          const row = yield* loadWebHostnameEffect(input.id)
          if (!row) {
            return yield* DomainConfigurationError.make({
              message: "This hostname no longer exists",
            })
          }
          yield* promiseEffect(() =>
            requireResourcePermission(person, row, true)
          )
          return { actor: domainActor(person), row }
        })
      )
    ),
  locks: ({ context: { row } }) => [exclusive(dnsKey(row))],
  run: ({ context: { actor, row }, input }) =>
    adoptExistingWebRecordEffect(row, {
      actor,
      record: input.record,
    }).pipe(
      Effect.map((after) => ({
        lastError: after?.lastError ?? null,
        status: after?.status ?? null,
      }))
    ),
  audit: ({ context: { row } }) => ({
    id: row.resourceId,
    kind: row.resourceType,
    relayId: row.relayId,
  }),
})

/**
 * Lets Kiln manage the record Cloudflare already had under a hostname: it
 * points it at the Relay, and deletes it with the route.
 */
export async function adoptWebHostnameRecordHandler(
  data: AdoptWebHostnameRecordInput
) {
  // Signed in before the lookup, so an ID's existence isn't revealed.
  return runOperationPromise(adoptRecord, data, {
    user: await requireEligibleResourceUser(),
  })
}

/**
 * Saves a resource's web routes with `save`, holding the hostnames they use
 * first so no other game server or app takes them meanwhile. Refuses
 * hostnames the resource may not take, naming the game server or app that
 * holds one when the person can see it, and lets go of its claims if the
 * save fails. Hostnames the routes stop using are marked for removal.
 */
export async function saveClaimingWebRouteHostnames<T>(
  user: AuthenticatedUser,
  resource: WebHostnameResource,
  hostnames: ReadonlyArray<string>,
  save: () => Promise<T>,
  proxy?: WebHostnameProxyChange
): Promise<T> {
  return runAppEffect(
    "webHostnames.claimAndSave",
    saveWebRouteHostnamesEffect(
      { actor: domainActor(user), hostnames, proxy, resource },
      promiseEffect(save)
    ).pipe(
      // The save's own failure passes through as it was thrown.
      Effect.catchIf(
        (error): error is HostnameInUseError =>
          error instanceof HostnameInUseError,
        (error) => explainHostnameInUseEffect(user, error)
      )
    )
  )
}

/**
 * Brings a resource's DNS records in line with the web routes just saved.
 * Never fails the save: a hostname Kiln can't manage shows why on its row,
 * and the DNS worker retries it.
 */
export async function syncWebRouteHostnames(
  resource: WebHostnameResource
): Promise<void> {
  const changed = await runAppEffect(
    "webHostnames.sync",
    reconcileResourceAddressesEffect(resource).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          console.warn(
            `[Kiln Domains] Web routes for ${resource.resourceType} ${resource.resourceId} were saved, but their DNS records could not be synced yet:`,
            cause
          )
          return true
        })
      )
    )
  )
  if (changed) publishWebHostnameChange([resource.relayId])
}

/** Gives a new app its address, when a vanity domain applies. */
export async function generateAppHostnameBestEffort(
  resource: WebHostnameResource
): Promise<void> {
  const hostname = await runAppEffect(
    "webHostnames.generate",
    generateAppHostnameEffect(resource).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          console.warn(
            `[Kiln Domains] App ${resource.resourceId} was created, but its address could not be generated:`,
            cause
          )
          return null
        })
      )
    )
  )
  if (hostname) publishWebHostnameChange([resource.relayId])
}

/** Deletes the records a deleted App or game server had. */
export async function deleteResourceAddressesBestEffort(
  resource: WebHostnameResource
): Promise<void> {
  // Marked for certain first: a delete that fails after, or is turned away
  // before it starts, is the DNS worker's to finish, not lost with the
  // resource.
  await runAppEffect(
    "addresses.markResourceRemoving",
    markResourceAddressesRemovingEffect(resource)
  )
  const removed = await runAppEffect(
    "addresses.deleteResource",
    deleteResourceAddressesEffect(resource).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          console.warn(
            `[Kiln Domains] Could not delete every DNS record for ${resource.resourceType} ${resource.resourceId}:`,
            cause
          )
          return 1
        })
      )
    )
  )
  if (removed > 0) publishWebHostnameChange([resource.relayId])
}
