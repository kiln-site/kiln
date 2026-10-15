/**
 * Registry credentials for pulls, from the Docker client config the CLI read:
 * `$DOCKER_CONFIG/config.json`, or `~/.docker/config.json`.
 *
 * Only `auths` entries are read. Credential helpers (`credsStore`,
 * `credHelpers`) are external programs the Relay image does not ship, so the
 * CLI could not have used them here either.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { Effect, Predicate, Result } from "effect"

import { DOCKER_HUB, type ImageReference } from "./docker-reference.js"

// The key Docker Hub credentials are saved under, as `docker login` does.
const DOCKER_HUB_SERVER = "https://index.docker.io/v1/"

interface AuthConfig {
  readonly identitytoken?: string
  readonly password?: string
  readonly serveraddress: string
  readonly username?: string
}

export function dockerConfigPath(
  environment: NodeJS.ProcessEnv = process.env
): string {
  const directory =
    environment.DOCKER_CONFIG?.trim() || join(homedir(), ".docker")
  return join(directory, "config.json")
}

/**
 * The `X-Registry-Auth` header for pulling `reference`, or undefined when
 * the config has no credentials for its registry. A missing or unreadable
 * config means anonymous pulls, as with the CLI.
 */
export function registryAuthHeader(
  reference: ImageReference,
  configPath = dockerConfigPath()
): Effect.Effect<string | undefined> {
  return Effect.tryPromise(() => readFile(configPath, "utf8")).pipe(
    Effect.map((text) => {
      const config = Result.getOrUndefined(
        Result.try((): unknown => JSON.parse(text))
      )
      const auth = authConfig(config, registryServer(reference))
      return auth && encodeAuthConfig(auth)
    }),
    Effect.orElseSucceed(() => undefined)
  )
}

/** Where `docker login` keeps a registry's credentials. */
function registryServer(reference: ImageReference): string {
  return reference.domain === DOCKER_HUB ? DOCKER_HUB_SERVER : reference.domain
}

function authConfig(config: unknown, server: string): AuthConfig | undefined {
  if (!Predicate.isObject(config) || !("auths" in config)) return undefined
  const auths = config.auths
  if (!Predicate.isObject(auths)) return undefined
  // An exact key first, then keys saved with a scheme or path, as the CLI's
  // file store matches them.
  const entries = Object.entries(auths)
  const entry =
    entries.find(([key]) => key === server) ??
    entries.find(([key]) => hostname(key) === hostname(server))
  if (!entry || !Predicate.isObject(entry[1])) return undefined
  const value = entry[1] as Record<string, unknown>
  const text = (name: string) =>
    Predicate.isString(value[name]) && value[name] ? value[name] : undefined
  let username = text("username")
  let password = text("password")
  const encoded = text("auth")
  if (encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8")
    const separator = decoded.indexOf(":")
    if (separator > 0) {
      username = decoded.slice(0, separator)
      password = decoded.slice(separator + 1)
    }
  }
  const identitytoken = text("identitytoken")
  if (!username && !identitytoken) return undefined
  return {
    ...(identitytoken ? { identitytoken } : {}),
    ...(password ? { password } : {}),
    serveraddress: server,
    ...(username ? { username } : {}),
  }
}

function hostname(server: string): string {
  const withoutScheme = server.replace(/^https?:\/\//u, "")
  return withoutScheme.split("/")[0] ?? withoutScheme
}

// As the CLI's `registry.EncodeAuthConfig`: URL-safe base64 of the JSON,
// padded, as Go's `base64.URLEncoding` writes and the daemon reads it.
function encodeAuthConfig(auth: AuthConfig): string {
  return Buffer.from(JSON.stringify(auth))
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
}
