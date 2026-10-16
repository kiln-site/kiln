/**
 * Registry credentials for pulls, from the Docker config file Compose and
 * buildx read too: `$DOCKER_CONFIG/config.json`, or `~/.docker/config.json`.
 * It is the file `docker login` writes, so one config gives every pull,
 * build, and Compose project on the Relay the same registries.
 *
 * Only `auths` entries are read. Credential helpers (`credsStore`,
 * `credHelpers`) are programs the Relay image doesn't ship.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { Effect, Predicate, Result } from "effect"

import { DOCKER_HUB, type ImageReference } from "./docker-reference.js"

// The key `docker login` saves Docker Hub credentials under.
const DOCKER_HUB_SERVER = "https://index.docker.io/v1/"

interface AuthConfig {
  readonly identitytoken?: string
  readonly password?: string
  readonly serveraddress: string
  readonly username?: string
}

/**
 * The `X-Registry-Auth` header for pulling `reference`, or undefined for an
 * anonymous pull: no config, one that can't be read, or no credentials for
 * its registry.
 */
export function registryAuthHeader(
  reference: ImageReference
): Effect.Effect<string | undefined> {
  const directory =
    process.env.DOCKER_CONFIG?.trim() || join(homedir(), ".docker")
  return Effect.tryPromise(() =>
    readFile(join(directory, "config.json"), "utf8")
  ).pipe(
    Effect.map((text) => {
      const auth = authConfig(
        Result.getOrUndefined(Result.try((): unknown => JSON.parse(text))),
        registryServer(reference)
      )
      return auth && encodeAuthConfig(auth)
    }),
    Effect.orElseSucceed(() => undefined)
  )
}

function registryServer(reference: ImageReference): string {
  return reference.domain === DOCKER_HUB ? DOCKER_HUB_SERVER : reference.domain
}

function authConfig(config: unknown, server: string): AuthConfig | undefined {
  if (!Predicate.isObject(config) || !("auths" in config)) return undefined
  const auths = config.auths
  if (!Predicate.isObject(auths)) return undefined
  // An exact key first, then one saved with a scheme or path.
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

// URL-safe base64 of the JSON, padded, which is how the daemon reads it.
function encodeAuthConfig(auth: AuthConfig): string {
  return Buffer.from(JSON.stringify(auth))
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
}
