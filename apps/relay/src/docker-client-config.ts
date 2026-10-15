/**
 * The Docker client config the CLI read, `$DOCKER_CONFIG/config.json` or
 * `~/.docker/config.json`, for what the CLI took from it: registry
 * credentials (see `./registry-auth.js`) and proxies for new containers.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { Effect, Predicate, Result } from "effect"

// The proxy settings the CLI passes on, by the config's key for each.
const PROXY_VARIABLES = {
  allProxy: "ALL_PROXY",
  ftpProxy: "FTP_PROXY",
  httpProxy: "HTTP_PROXY",
  httpsProxy: "HTTPS_PROXY",
  noProxy: "NO_PROXY",
} as const

/**
 * The Docker client config, parsed, or undefined when it is missing or
 * can't be read, which the CLI treated as an empty config.
 */
export function dockerClientConfig(): Effect.Effect<unknown> {
  const directory =
    process.env.DOCKER_CONFIG?.trim() || join(homedir(), ".docker")
  return Effect.tryPromise(() =>
    readFile(join(directory, "config.json"), "utf8")
  ).pipe(
    Effect.map(parseJson),
    Effect.orElseSucceed(() => undefined)
  )
}

export function parseJson(text: string): unknown {
  return Result.getOrUndefined(Result.try((): unknown => JSON.parse(text)))
}

/**
 * `env` with the config's proxies added, as the CLI's `docker create` and
 * Compose did: the `proxies` entry for the daemon the CLI talked to, or the
 * `default` one, each as an upper- and a lowercase variable. A variable
 * `env` already sets keeps its value.
 */
export function withProxyEnvironment(
  env: Readonly<Record<string, string>> | undefined
): Effect.Effect<Readonly<Record<string, string>> | undefined> {
  return dockerClientConfig().pipe(
    Effect.map((config) => {
      const proxies = proxyConfig(config)
      if (!proxies) return env
      const merged: Record<string, string> = { ...env }
      for (const [key, name] of Object.entries(PROXY_VARIABLES)) {
        const value = proxies[key]
        if (!Predicate.isString(value) || value === "") continue
        for (const variable of [name, name.toLowerCase()]) {
          if (!(variable in merged)) merged[variable] = value
        }
      }
      return merged
    })
  )
}

function proxyConfig(config: unknown): Record<string, unknown> | undefined {
  if (!Predicate.isObject(config) || !("proxies" in config)) return undefined
  const proxies = config.proxies
  if (!Predicate.isObject(proxies)) return undefined
  // The daemon the CLI talked to, as `DOCKER_HOST` or the default socket.
  const host =
    process.env.DOCKER_HOST?.trim() || "unix:///var/run/docker.sock"
  const entry = host in proxies ? proxies[host as keyof typeof proxies] : proxies.default
  return Predicate.isObject(entry) ? (entry as Record<string, unknown>) : undefined
}
