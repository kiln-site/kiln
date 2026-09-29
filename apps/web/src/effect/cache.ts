import * as Sentry from "@sentry/tanstackstart-react"
import { Context, Deferred, Effect, Exit, Layer } from "effect"
import { createClient } from "redis"
import type { RedisClientOptions } from "redis"

import { cacheConnectionConfig } from "@/lib/cache-config"
import type { CacheConnectionConfig } from "@/lib/cache-config"

import { CacheError } from "./errors"

type CacheBackend = "disabled" | "redis-protocol"
type RedisClient = ReturnType<typeof createClient>

const timeoutMs = 750

export class AppCache extends Context.Service<
  AppCache,
  {
    readonly backend: CacheBackend
    readonly enabled: boolean
    readonly get: (key: string) => Effect.Effect<string | undefined, CacheError>
    readonly remove: (key: string) => Effect.Effect<void, CacheError>
    readonly set: (
      key: string,
      value: string,
      ttlMs: number
    ) => Effect.Effect<void, CacheError>
  }
>()("kiln/AppCache") {}

const AppCacheDisabled = Layer.succeed(AppCache)({
  backend: "disabled",
  enabled: false,
  get: () => Effect.succeed(undefined),
  remove: () => Effect.void,
  set: () => Effect.void,
})

const configuredCache = cacheConnectionConfig()

export const AppCacheLive = configuredCache
  ? makeRedisCacheLayer(configuredCache)
  : AppCacheDisabled

function makeRedisCacheLayer(
  config: CacheConnectionConfig
): Layer.Layer<AppCache> {
  return Layer.effect(AppCache)(
    Effect.gen(function* () {
      // node-redis only times out commands until they are written, and its
      // connect timeout ends before the handshake. Own the client so every
      // cache call gets one deadline, and destroy it on timeout so the next
      // call reconnects. Concurrent calls share a single connection attempt.
      const scope = yield* Effect.scope
      let client: RedisClient | undefined
      let connecting: Deferred.Deferred<RedisClient, Error> | undefined
      let retryAt = 0

      const reset = () => {
        if (client) destroy(client)
        client = undefined
      }
      yield* Effect.addFinalizer(() => Effect.sync(reset))

      // Starting an attempt is uninterruptible so the client is always
      // owned by the forked attempt; waiting for it stays interruptible.
      const startConnecting = Effect.uninterruptible(
        Effect.suspend(() => {
          if (connecting) return Effect.succeed(connecting)
          reset()
          const next = createClient(redisOptions(config))
          // Failures surface through connect and commands; node-redis
          // rethrows error events that have no listener.
          next.on("error", () => undefined)
          const attempt = Deferred.makeUnsafe<RedisClient, Error>()
          connecting = attempt
          // Runs in the layer scope, so disposal interrupts it and every
          // exit other than success destroys the pending client.
          return Effect.tryPromise(() => next.connect()).pipe(
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () =>
                Effect.fail(new Error("Cache connection timed out")),
            }),
            Effect.as(next),
            Effect.onExit((exit) =>
              Effect.sync(() => {
                connecting = undefined
                if (Exit.isSuccess(exit)) client = next
                else destroy(next)
              })
            ),
            Deferred.into(attempt),
            Effect.interruptible,
            Effect.forkIn(scope),
            Effect.as(attempt)
          )
        })
      )

      const connected = Effect.suspend(() =>
        client?.isReady
          ? Effect.succeed(client)
          : startConnecting.pipe(Effect.flatMap(Deferred.await))
      )

      const command = <TResult>(
        operation: string,
        run: (client: RedisClient) => Promise<TResult>,
        resultAttributes?: (
          result: TResult
        ) => Record<string, boolean | number | string>
      ): Effect.Effect<TResult, CacheError> =>
        Effect.suspend(() => {
          if (Date.now() < retryAt) {
            return Effect.fail(
              CacheError.make({
                operation,
                cause: new Error("Cache circuit is temporarily open"),
              })
            )
          }
          let used: RedisClient | undefined
          return connected.pipe(
            Effect.flatMap((redis) => {
              used = redis
              return Effect.tryPromise(() =>
                Sentry.startSpan(
                  {
                    name: `${operation} cache`,
                    op: "cache.redis",
                    attributes: { "cache.backend": "redis-protocol" },
                  },
                  async (span) => {
                    const result = await run(redis)
                    const attributes = resultAttributes?.(result) ?? {}
                    for (const [name, value] of Object.entries(attributes)) {
                      span.setAttribute(name, value)
                    }
                    return result
                  }
                )
              )
            }),
            // One deadline covers waiting for the connection and the reply.
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () =>
                Effect.sync(() => {
                  // A stalled reply leaves the connection unusable.
                  if (used && used === client) reset()
                }).pipe(
                  Effect.andThen(Effect.fail(new Error("Cache call timed out")))
                ),
            }),
            Effect.mapError((cause) => CacheError.make({ operation, cause })),
            Effect.tap(() =>
              Effect.sync(() => {
                retryAt = 0
              })
            ),
            Effect.tapError(() =>
              Effect.sync(() => {
                retryAt = Date.now() + 5_000
              })
            )
          )
        })

      const fullKey = (key: string) => `${config.namespace}:${key}`

      const backend: CacheBackend = "redis-protocol"
      return {
        backend,
        enabled: true,
        get: (key: string) =>
          command(
            "GET",
            (redis) => redis.get(fullKey(key)),
            (value) => ({
              "cache.hit": value !== null,
            })
          ).pipe(Effect.map((value) => value ?? undefined)),
        remove: (key: string) =>
          command("DEL", async (redis) => {
            await redis.del(fullKey(key))
          }),
        set: (key: string, value: string, ttlMs: number) =>
          command("SET", async (redis) => {
            await redis.set(fullKey(key), value, {
              expiration: { type: "PX", value: ttlMs },
            })
          }),
      }
    })
  )
}

// destroy() throws once the client has closed itself.
function destroy(client: RedisClient) {
  if (client.isOpen) client.destroy()
}

function redisOptions(config: CacheConnectionConfig): RedisClientOptions {
  return {
    username: config.username,
    password: config.password,
    database: config.database,
    disableOfflineQueue: true,
    socket: {
      host: config.host,
      port: config.port,
      connectTimeout: timeoutMs,
      // Reconnect on the next command instead of in the background.
      reconnectStrategy: false,
      ...(config.tls ? { tls: true, servername: config.host } : {}),
    },
  }
}
