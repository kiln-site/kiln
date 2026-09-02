import { WebSocket } from "ws"

import type {
  RelayBrowserAuthorizationRevision,
  RelayBrowserCapabilityV2,
  RelayBrowserOperationKind,
} from "@workspace/contracts"

import type { RelayConfig } from "./config.js"

type BrowserLimits = RelayConfig["browserLimits"]

export interface BrowserSessionAuthority {
  readonly actions: ReadonlySet<string>
  readonly expiresAt: number
  readonly instanceId: string
  readonly issuer: string
  readonly issuerGeneration: number
  readonly keyThumbprint: string
  readonly loginSessionId: string | null
  readonly operation: RelayBrowserOperationKind | null
  readonly origin: string
  readonly revision: number
  readonly subject: string
  readonly version: 1 | 2
}

interface ActiveSession {
  active: boolean
  authority: BrowserSessionAuthority
  expiryTimer: NodeJS.Timeout | null
  renewalNonce: string | null
  renewalNonceExpiresAt: number | null
  sessionId: string
}

interface Transfer extends BrowserSessionAuthority {
  readonly abort: () => void
  active: boolean
}

interface FloorState {
  readonly issuer: string
  readonly minimumRevision: number
  readonly scope: RelayBrowserAuthorizationRevision["scope"]
  readonly subject: string
}

export class BrowserSessionRegistry {
  readonly #established = new Map<WebSocket, ActiveSession>()
  readonly #floorState = new Map<string, FloorState>()
  readonly #issuerGenerations = new Map<string, number>()
  readonly #limits: BrowserLimits
  readonly #pending = new Map<WebSocket, string>()
  readonly #pendingByIp = new Map<string, number>()
  readonly #transfers = new Set<Transfer>()

  constructor(limits: BrowserLimits) {
    this.#limits = limits
  }

  acquirePending(
    socket: WebSocket,
    peerIp: string,
    enforceIp: boolean
  ): boolean {
    if (this.#pending.size >= this.#limits.pendingHandshakes) return false
    const current = this.#pendingByIp.get(peerIp) ?? 0
    if (enforceIp && current >= this.#limits.pendingHandshakesPerIp)
      return false
    this.#pending.set(socket, peerIp)
    this.#pendingByIp.set(peerIp, current + 1)
    return true
  }

  activate(
    socket: WebSocket,
    authority: BrowserSessionAuthority,
    sessionId: string,
    current: { issuerGeneration: number; minimumRevision: number },
    renewal?: { nonce: string; nonceExpiresAt: number }
  ):
    | {
        accepted: true
        reason: null
        replaced: WebSocket | null
      }
    | {
        accepted: false
        reason: "authorization" | "capacity"
        replaced: WebSocket | null
      } {
    this.releasePending(socket)
    this.#issuerGenerations.set(
      authority.issuer,
      Math.max(
        this.#issuerGenerations.get(authority.issuer) ?? 0,
        current.issuerGeneration
      )
    )
    if (
      authority.version === 2 &&
      (authority.issuerGeneration !== current.issuerGeneration ||
        authority.issuerGeneration !==
          (this.#issuerGenerations.get(authority.issuer) ?? 0) ||
        authority.revision < current.minimumRevision ||
        authority.revision < this.minimumRevision(authority))
    ) {
      return { accepted: false, reason: "authorization", replaced: null }
    }

    let replaced: WebSocket | null = null
    for (const [candidate, session] of this.#established) {
      if (candidate === socket || !sameOwner(session.authority, authority)) {
        continue
      }
      replaced = candidate
      this.release(candidate)
      candidate.close(1012, "Browser session replaced")
      break
    }

    if (!this.#withinLimits(authority)) {
      return { accepted: false, reason: "capacity", replaced }
    }
    const session: ActiveSession = {
      active: true,
      authority,
      expiryTimer: null,
      renewalNonce: renewal?.nonce ?? null,
      renewalNonceExpiresAt: renewal?.nonceExpiresAt ?? null,
      sessionId,
    }
    this.#established.set(socket, session)
    this.#armExpiry(socket, session)
    return { accepted: true, reason: null, replaced }
  }

  renew(
    socket: WebSocket,
    authority: BrowserSessionAuthority,
    nonce: string,
    nonceExpiresAt: number
  ): boolean {
    const session = this.#established.get(socket)
    if (
      !session?.active ||
      !sameOwner(session.authority, authority) ||
      authority.version !== 2 ||
      authority.issuerGeneration !==
        (this.#issuerGenerations.get(authority.issuer) ?? 0) ||
      authority.revision < this.minimumRevision(authority)
    ) {
      return false
    }
    session.authority = authority
    session.renewalNonce = nonce
    session.renewalNonceExpiresAt = nonceExpiresAt
    this.#armExpiry(socket, session)
    return true
  }

  renewalChallenge(socket: WebSocket) {
    const session = this.#established.get(socket)
    if (
      !session?.active ||
      !session.renewalNonce ||
      !session.renewalNonceExpiresAt
    ) {
      return null
    }
    return {
      nonce: session.renewalNonce,
      nonceExpiresAt: session.renewalNonceExpiresAt,
      sessionId: session.sessionId,
    }
  }

  authority(socket: WebSocket): BrowserSessionAuthority | null {
    return this.#established.get(socket)?.authority ?? null
  }

  isActive(socket: WebSocket, requiredAction?: string): boolean {
    const session = this.#established.get(socket)
    if (!session?.active) return false
    if (session.authority.expiresAt <= Date.now()) {
      this.#deactivate(socket, "Browser capability expired")
      return false
    }
    return !requiredAction || session.authority.actions.has(requiredAction)
  }

  registerTransfer(authority: BrowserSessionAuthority, abort: () => void) {
    const transfer: Transfer = { ...authority, abort, active: true }
    this.#transfers.add(transfer)
    return {
      active: () => transfer.active && this.#authorityIsCurrent(transfer),
      release: () => this.#transfers.delete(transfer),
    }
  }

  revise(
    issuer: string,
    items: ReadonlyArray<RelayBrowserAuthorizationRevision>,
    issuerGeneration: number
  ): void {
    this.#issuerGenerations.set(
      issuer,
      Math.max(this.#issuerGenerations.get(issuer) ?? 0, issuerGeneration)
    )
    for (const item of items) {
      const key = floorKey(issuer, item.subject, item.scope)
      const current = this.#floorState.get(key)
      if (!current || item.minimumRevision > current.minimumRevision) {
        this.#floorState.set(key, { issuer, ...item })
      }
    }
    for (const [socket, session] of this.#established) {
      if (!this.#authorityIsCurrent(session.authority)) {
        this.#deactivate(socket, "Browser authorization changed")
      }
    }
    for (const transfer of this.#transfers) {
      if (!this.#authorityIsCurrent(transfer)) {
        transfer.active = false
        transfer.abort()
        this.#transfers.delete(transfer)
      }
    }
  }

  revokeIssuer(issuer: string): void {
    for (const [socket, session] of this.#established) {
      if (session.authority.issuer === issuer) {
        this.#deactivate(socket, "Capability issuer changed")
      }
    }
    for (const transfer of this.#transfers) {
      if (transfer.issuer !== issuer) continue
      transfer.active = false
      transfer.abort()
      this.#transfers.delete(transfer)
    }
  }

  releasePending(socket: WebSocket): void {
    const peerIp = this.#pending.get(socket)
    if (!peerIp) return
    this.#pending.delete(socket)
    const next = (this.#pendingByIp.get(peerIp) ?? 1) - 1
    if (next > 0) this.#pendingByIp.set(peerIp, next)
    else this.#pendingByIp.delete(peerIp)
  }

  release(socket: WebSocket): void {
    this.releasePending(socket)
    const session = this.#established.get(socket)
    if (!session) return
    session.active = false
    if (session.expiryTimer) clearTimeout(session.expiryTimer)
    this.#established.delete(socket)
  }

  close(): void {
    for (const socket of this.#established.keys()) this.release(socket)
    for (const socket of this.#pending.keys()) this.releasePending(socket)
    for (const transfer of this.#transfers) transfer.abort()
    this.#transfers.clear()
  }

  minimumRevision(authority: BrowserSessionAuthority): number {
    let minimum = 0
    const scopes: ReadonlyArray<RelayBrowserAuthorizationRevision["scope"]> = [
      { kind: "subject_relay" },
      { instanceId: authority.instanceId, kind: "instance" },
      ...(authority.loginSessionId
        ? ([
            {
              kind: "login_session",
              loginSessionId: authority.loginSessionId,
            },
          ] as const)
        : []),
    ]
    for (const scope of scopes) {
      minimum = Math.max(
        minimum,
        this.#floorState.get(
          floorKey(authority.issuer, authority.subject, scope)
        )?.minimumRevision ?? 0
      )
    }
    return minimum
  }

  #authorityIsCurrent(authority: BrowserSessionAuthority): boolean {
    if (authority.expiresAt <= Date.now()) return false
    if (authority.version !== 2) return true
    return (
      authority.issuerGeneration ===
        (this.#issuerGenerations.get(authority.issuer) ?? 0) &&
      authority.revision >= this.minimumRevision(authority)
    )
  }

  #armExpiry(socket: WebSocket, session: ActiveSession): void {
    if (session.expiryTimer) clearTimeout(session.expiryTimer)
    session.expiryTimer = null
    session.expiryTimer = setTimeout(
      () => {
        if (this.#established.get(socket) === session) {
          this.#deactivate(socket, "Browser capability expired")
        }
      },
      Math.max(0, session.authority.expiresAt - Date.now())
    )
    session.expiryTimer.unref()
  }

  #deactivate(socket: WebSocket, reason: string): void {
    const session = this.#established.get(socket)
    if (!session) return
    session.active = false
    socket.close(4403, reason)
  }

  #withinLimits(authority: BrowserSessionAuthority): boolean {
    if (this.#established.size >= this.#limits.sessions) return false
    if (!this.#limits.sublimitsEnforced) return true
    let instance = 0
    let user = 0
    let userInstance = 0
    for (const session of this.#established.values()) {
      const existing = session.authority
      if (existing.issuer !== authority.issuer) continue
      if (existing.instanceId === authority.instanceId) instance += 1
      if (existing.subject === authority.subject) user += 1
      if (
        existing.subject === authority.subject &&
        existing.instanceId === authority.instanceId
      ) {
        userInstance += 1
      }
    }
    return (
      instance < this.#limits.sessionsPerInstance &&
      user < this.#limits.sessionsPerUser &&
      userInstance < this.#limits.sessionsPerUserInstance
    )
  }
}

export function authorityFromCapability(
  capability: RelayBrowserCapabilityV2
): BrowserSessionAuthority {
  return {
    actions: new Set(capability.actions),
    expiresAt: capability.expiresAt,
    instanceId: capability.instanceId,
    issuer: capability.issuer,
    issuerGeneration: capability.issuerGeneration,
    keyThumbprint: capability.keyThumbprint,
    loginSessionId: capability.loginSessionId,
    operation: capability.operation,
    origin: capability.origin,
    revision: capability.authorizationRevision,
    subject: capability.subject,
    version: 2,
  }
}

function sameOwner(
  left: BrowserSessionAuthority,
  right: BrowserSessionAuthority
): boolean {
  return (
    left.issuer === right.issuer &&
    left.subject === right.subject &&
    left.loginSessionId === right.loginSessionId &&
    left.keyThumbprint === right.keyThumbprint &&
    left.instanceId === right.instanceId &&
    left.operation === right.operation
  )
}

function floorKey(
  issuer: string,
  subject: string,
  scope: RelayBrowserAuthorizationRevision["scope"]
): string {
  const id =
    scope.kind === "instance"
      ? scope.instanceId
      : scope.kind === "login_session"
        ? scope.loginSessionId
        : ""
  return `${issuer}\0${subject}\0${scope.kind}\0${id}`
}
