import { Effect } from "effect"

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
  active: Map<BrowserCapabilityRequest["kind"], BrowserCapabilityRequest>
  credentials: Promise<RelayBrowserCredentials>
  flushScheduled: boolean
  instanceId: string
  pending: Map<
    BrowserCapabilityRequest["kind"],
    {
      request: BrowserCapabilityRequest
      waiters: Array<{
        reject: (cause: unknown) => void
        resolve: (capability: IssuedBrowserCapability) => void
      }>
    }
  >
  references: number
  relayId: string
}

const credentialsByInstance = new Map<string, CredentialEntry>()
const authorizationListeners = new Map<string, Set<() => void>>()
const authorizationVersions = new Map<string, number>()

export function notifyRelayBrowserAuthorizationChanged(): void {
  for (const id of credentialsByInstance.keys()) {
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
        if (listeners.size === 0) authorizationListeners.delete(id)
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
    entry = {
      active: new Map(),
      credentials: createCredentials(),
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
  const ownedKinds = new Set<BrowserCapabilityRequest["kind"]>()
  const activate = (request: BrowserCapabilityRequest) => {
    ownedKinds.add(request.kind)
    entry.active.set(request.kind, request)
  }
  return {
    credentials: entry.credentials,
    issue: (request) => {
      activate(request)
      return issueCapability(entry, request)
    },
    onAuthorizationChange: (listener) => {
      const listeners = authorizationListeners.get(id) ?? new Set()
      listeners.add(listener)
      authorizationListeners.set(id, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) authorizationListeners.delete(id)
      }
    },
    release: () => {
      if (released) return
      released = true
      const current = credentialsByInstance.get(id)
      if (current !== entry) return
      for (const kind of ownedKinds) current.active.delete(kind)
      current.references -= 1
      if (current.references === 0) {
        credentialsByInstance.delete(id)
        authorizationVersions.delete(id)
      }
    },
    renew: (request) => {
      activate(request)
      for (const active of entry.active.values()) {
        enqueueCapability(entry, active)
      }
      return issueCapability(entry, request)
    },
  }
}

function issueCapability(
  entry: CredentialEntry,
  request: BrowserCapabilityRequest
): Promise<IssuedBrowserCapability> {
  return new Promise((resolve, reject) => {
    enqueueCapability(entry, request, { reject, resolve })
  })
}

function enqueueCapability(
  entry: CredentialEntry,
  request: BrowserCapabilityRequest,
  waiter?: {
    reject: (cause: unknown) => void
    resolve: (capability: IssuedBrowserCapability) => void
  }
): void {
  const pending = entry.pending.get(request.kind) ?? { request, waiters: [] }
  pending.request = request
  if (waiter) pending.waiters.push(waiter)
  entry.pending.set(request.kind, pending)
  if (entry.flushScheduled) return
  entry.flushScheduled = true
  queueMicrotask(() => void flushCapabilities(entry))
}

function flushCapabilities(entry: CredentialEntry): Promise<void> {
  entry.flushScheduled = false
  const pending = [...entry.pending.values()]
  entry.pending.clear()
  if (pending.length === 0) return Promise.resolve()
  return Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        const credentials = await entry.credentials
        return issueBrowserCapabilities({
          data: {
            instanceId: entry.instanceId,
            publicKeyJwk: credentials.publicKeyJwk,
            relayId: entry.relayId,
            requests: pending.map(({ request }) => request),
          },
        })
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.match({
        onFailure: (cause) => {
          for (const item of pending) {
            for (const waiter of item.waiters) waiter.reject(cause)
          }
        },
        onSuccess: (response) => {
          for (const item of pending) {
            const capability = response.capabilities.find(
              (candidate) => candidate.kind === item.request.kind
            )
            if (capability) {
              for (const waiter of item.waiters) waiter.resolve(capability)
              continue
            }
            for (const waiter of item.waiters) {
              waiter.reject(new Error("Hearth omitted a Relay capability"))
            }
          }
        },
      })
    )
  )
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
