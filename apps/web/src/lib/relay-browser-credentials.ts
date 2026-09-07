import { Effect } from "effect"

import { forkPromise } from "@/effect/promise"
import { issueBrowserCapabilities } from "@/server/relay-capability"

type BrowserCapabilityRequest =
  | { kind: "console"; optInV2: boolean; write: boolean }
  | { kind: "resources"; optInV2: boolean }

type IssuedBrowserCapability = Awaited<
  ReturnType<typeof issueBrowserCapabilities>
>["capabilities"][number]

export interface RelayBrowserCredentials {
  keys: CryptoKeyPair
  publicKeyJwk: {
    crv: "P-256"
    kty: "EC"
    x: string
    y: string
  }
}

interface CredentialEntry {
  activeBatches: Map<string, ActiveCapabilityBatch>
  credentials: Promise<RelayBrowserCredentials>
  flushScheduled: boolean
  instanceId: string
  pending: Map<string, PendingCapability>
  references: number
  relayId: string
}

interface CapabilityWaiter {
  reject: (cause: unknown) => void
  resolve: (capability: IssuedBrowserCapability) => void
  settled: boolean
}

interface PendingCapability {
  request: BrowserCapabilityRequest
  waiters: Array<CapabilityWaiter>
}

interface ActiveCapabilityBatch {
  controller: AbortController
  items: Array<PendingCapability>
}

const credentialsByInstance = new Map<string, CredentialEntry>()
const authorizationListeners = new Map<string, Set<() => void>>()
const authorizationVersions = new Map<string, number>()

export function notifyRelayBrowserAuthorizationChanged(): void {
  const ids = new Set([
    ...credentialsByInstance.keys(),
    ...authorizationListeners.keys(),
  ])
  for (const id of ids) {
    authorizationVersions.set(id, (authorizationVersions.get(id) ?? 0) + 1)
    for (const listener of authorizationListeners.get(id) ?? []) listener()
  }
}

export function relayBrowserAuthorizationSignal(
  relayId: string,
  instanceId: string
): {
  getSnapshot: () => number
  subscribe: (listener: () => void) => () => void
} {
  const id = `${relayId}:${instanceId}`
  return {
    getSnapshot: () => authorizationVersions.get(id) ?? 0,
    subscribe: (listener) => {
      const listeners = authorizationListeners.get(id) ?? new Set()
      listeners.add(listener)
      authorizationListeners.set(id, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          authorizationListeners.delete(id)
          if (!credentialsByInstance.has(id)) authorizationVersions.delete(id)
        }
      }
    },
  }
}

/**
 * Shares one non-extractable proof key between the console and resource
 * sockets owned by one browser tab and instance route. The entry disappears
 * as soon as the last feature releases it, so navigation cannot reuse
 * authority across instances.
 */
export function acquireRelayBrowserCredentials(
  relayId: string,
  instanceId: string
): {
  credentials: Promise<RelayBrowserCredentials>
  issue: (request: BrowserCapabilityRequest) => Promise<IssuedBrowserCapability>
  renew: (request: BrowserCapabilityRequest) => Promise<IssuedBrowserCapability>
  onAuthorizationChange: (listener: () => void) => () => void
  release: () => void
} {
  const id = `${relayId}:${instanceId}`
  let entry = credentialsByInstance.get(id)
  if (!entry) {
    const credentials = createCredentials()
    // An owner may release during key generation before it ever awaits this
    // shared promise. Retain rejection for consumers without reporting an
    // unhandled rejection from an already-abandoned entry.
    forkPromise(() => credentials)
    entry = {
      activeBatches: new Map(),
      credentials,
      flushScheduled: false,
      instanceId,
      pending: new Map(),
      references: 0,
      relayId,
    }
    credentialsByInstance.set(id, entry)
  }
  entry.references += 1
  let released = false
  const waiters = new Set<CapabilityWaiter>()
  const issue = (request: BrowserCapabilityRequest) =>
    released
      ? Promise.reject(new Error("Relay browser credentials were released"))
      : issueCapability(entry, request, waiters)
  return {
    credentials: entry.credentials,
    issue,
    onAuthorizationChange: (listener) => {
      const listeners = authorizationListeners.get(id) ?? new Set()
      listeners.add(listener)
      authorizationListeners.set(id, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          authorizationListeners.delete(id)
          if (!credentialsByInstance.has(id)) authorizationVersions.delete(id)
        }
      }
    },
    release: () => {
      if (released) return
      released = true
      for (const waiter of waiters) {
        settleWaiter(
          waiter,
          "reject",
          new Error("Relay browser credentials were released")
        )
      }
      waiters.clear()
      removeSettledWaiters(entry)
      const current = credentialsByInstance.get(id)
      if (current !== entry) return
      current.references -= 1
      if (current.references === 0) {
        credentialsByInstance.delete(id)
        if (!authorizationListeners.has(id)) authorizationVersions.delete(id)
      }
    },
    // Batch only requested capabilities. Issuing for the other socket without
    // delivering that token did extra authorization/signing work every renewal.
    renew: issue,
  }
}

function issueCapability(
  entry: CredentialEntry,
  request: BrowserCapabilityRequest,
  owner: Set<CapabilityWaiter>
): Promise<IssuedBrowserCapability> {
  return new Promise((resolve, reject) => {
    const waiter: CapabilityWaiter = {
      reject: (cause) => {
        owner.delete(waiter)
        reject(cause)
      },
      resolve: (capability) => {
        owner.delete(waiter)
        resolve(capability)
      },
      settled: false,
    }
    owner.add(waiter)
    enqueueCapability(entry, request, waiter)
  })
}

function enqueueCapability(
  entry: CredentialEntry,
  request: BrowserCapabilityRequest,
  waiter: CapabilityWaiter
): void {
  const key = capabilityRequestKey(request)
  const activeBatch = entry.activeBatches.get(key)
  const active = activeBatch?.controller.signal.aborted
    ? undefined
    : activeBatch?.items.find(
        (item) => capabilityRequestKey(item.request) === key
      )
  if (active) {
    active.waiters.push(waiter)
    return
  }
  const pending = entry.pending.get(key) ?? { request, waiters: [] }
  pending.waiters.push(waiter)
  entry.pending.set(key, pending)
  scheduleFlush(entry)
}

function scheduleFlush(entry: CredentialEntry): void {
  if (entry.flushScheduled || entry.pending.size === 0) return
  entry.flushScheduled = true
  queueMicrotask(() => void flushCapabilities(entry))
}

function flushCapabilities(entry: CredentialEntry): Promise<void> {
  entry.flushScheduled = false
  removeSettledWaiters(entry)
  const pending: Array<PendingCapability> = []
  const kinds = new Set<BrowserCapabilityRequest["kind"]>()
  for (const [key, item] of entry.pending) {
    if (kinds.has(item.request.kind)) continue
    kinds.add(item.request.kind)
    pending.push(item)
    entry.pending.delete(key)
  }
  if (pending.length === 0) return Promise.resolve()
  const controller = new AbortController()
  const activeBatch = { controller, items: pending }
  for (const item of pending) {
    entry.activeBatches.set(capabilityRequestKey(item.request), activeBatch)
  }
  // A second authority shape for a selected kind cannot share this server
  // batch, but it also need not wait for this network request to finish.
  scheduleFlush(entry)
  return Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        const credentials = await entry.credentials
        controller.signal.throwIfAborted()
        return issueBrowserCapabilities({
          data: {
            instanceId: entry.instanceId,
            publicKeyJwk: credentials.publicKeyJwk,
            relayId: entry.relayId,
            requests: pending.map(({ request }) => request),
          },
          signal: controller.signal,
        })
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.match({
        onFailure: (cause) => {
          for (const item of pending) {
            for (const waiter of item.waiters) {
              settleWaiter(waiter, "reject", cause)
            }
          }
        },
        onSuccess: (response) => {
          const capabilities = new Map(
            response.capabilities.map((capability) => [
              capability.kind,
              capability,
            ])
          )
          for (const item of pending) {
            const capability = capabilities.get(item.request.kind)
            if (capability) {
              for (const waiter of item.waiters) {
                settleWaiter(waiter, "resolve", capability)
              }
              continue
            }
            for (const waiter of item.waiters) {
              settleWaiter(
                waiter,
                "reject",
                new Error("Hearth omitted a Relay capability")
              )
            }
          }
        },
      }),
      Effect.ensuring(
        Effect.sync(() => {
          for (const item of pending) {
            const key = capabilityRequestKey(item.request)
            if (entry.activeBatches.get(key) === activeBatch) {
              entry.activeBatches.delete(key)
            }
          }
          removeSettledWaiters(entry)
          scheduleFlush(entry)
        })
      )
    )
  )
}

function capabilityRequestKey(request: BrowserCapabilityRequest): string {
  return request.kind === "console"
    ? `console:${request.optInV2}:${request.write}`
    : `resources:${request.optInV2}`
}

function removeSettledWaiters(entry: CredentialEntry): void {
  for (const [key, item] of entry.pending) {
    item.waiters = item.waiters.filter((waiter) => !waiter.settled)
    if (item.waiters.length === 0) entry.pending.delete(key)
  }
  for (const active of new Set(entry.activeBatches.values())) {
    if (
      active.items.every((item) =>
        item.waiters.every((waiter) => waiter.settled)
      )
    ) {
      active.controller.abort()
    }
  }
}

function settleWaiter(
  waiter: CapabilityWaiter,
  outcome: "reject" | "resolve",
  value: unknown
): void {
  if (waiter.settled) return
  waiter.settled = true
  if (outcome === "resolve") {
    waiter.resolve(value as IssuedBrowserCapability)
  } else {
    waiter.reject(value)
  }
}

async function createCredentials(): Promise<RelayBrowserCredentials> {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"]
  )
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keys.publicKey)
  return {
    keys,
    publicKeyJwk: {
      crv: "P-256",
      kty: "EC",
      x: requiredCoordinate(publicKeyJwk.x),
      y: requiredCoordinate(publicKeyJwk.y),
    },
  }
}

function requiredCoordinate(value: string | undefined): string {
  if (!value) throw new Error("Browser could not create a Relay session key")
  return value
}
