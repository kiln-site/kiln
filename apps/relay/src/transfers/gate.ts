/**
 * How many direct transfers the Relay serves at once. Each kind of
 * transfer draws from its own pool, with a share for each principal (a
 * paired Hearth's browsers, a download link's issuer), so one busy client
 * can't take every slot. A permit is held for the transfer's scope and
 * returned however it ends.
 */
import { Effect, Scope } from "effect"

import { TransferRejected } from "./http.js"

export type TransferPool = "backup" | "browser"

export interface TransferPoolLimits {
  readonly total: number
  readonly perPrincipal: number
}

export const defaultTransferPoolLimits: Readonly<
  Record<TransferPool, TransferPoolLimits>
> = {
  // Downloads, uploads, and dump imports from browsers.
  browser: { total: 32, perPrincipal: 8 },
  // Backup archives fetched through signed download links.
  backup: { total: 4, perPrincipal: 4 },
}

interface PoolState {
  active: number
  readonly byPrincipal: Map<string, number>
  readonly limits: TransferPoolLimits
}

export class TransferGate {
  readonly #pools: Record<TransferPool, PoolState>

  constructor(
    limits: Readonly<
      Record<TransferPool, TransferPoolLimits>
    > = defaultTransferPoolLimits
  ) {
    this.#pools = {
      backup: { active: 0, byPrincipal: new Map(), limits: limits.backup },
      browser: { active: 0, byPrincipal: new Map(), limits: limits.browser },
    }
  }

  /** Transfers running in `pool`, or in every pool. */
  active(pool?: TransferPool): number {
    if (pool) return this.#pools[pool].active
    let total = 0
    for (const state of Object.values(this.#pools)) total += state.active
    return total
  }

  /**
   * Holds a slot in `pool` for `principal` until the scope closes, or
   * refuses with 429 when the pool or the principal's share is full.
   */
  admit(
    pool: TransferPool,
    principal: string
  ): Effect.Effect<void, TransferRejected, Scope.Scope> {
    const state = this.#pools[pool]
    return Effect.acquireRelease(
      Effect.suspend(() => {
        const held = state.byPrincipal.get(principal) ?? 0
        if (
          state.active >= state.limits.total ||
          held >= state.limits.perPrincipal
        ) {
          return Effect.fail(
            new TransferRejected({
              status: 429,
              reason:
                pool === "backup"
                  ? "Relay backup download capacity reached"
                  : "Relay file transfer capacity reached",
            })
          )
        }
        state.active += 1
        state.byPrincipal.set(principal, held + 1)
        return Effect.void
      }),
      () =>
        Effect.sync(() => {
          state.active -= 1
          const remaining = (state.byPrincipal.get(principal) ?? 1) - 1
          if (remaining > 0) state.byPrincipal.set(principal, remaining)
          else state.byPrincipal.delete(principal)
        })
    )
  }
}
