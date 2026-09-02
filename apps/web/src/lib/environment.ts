import { Option, Schema } from "effect"

import {
  kilnGitRepositoryRawUrl,
  resolveKilnGitRepository,
} from "@workspace/contracts"

import { parseSecretKeyring } from "../../keyring.mjs"
import type { VersionedSecret } from "../../keyring.mjs"
import { rootDomainForHostname } from "@/lib/domain-name"

export interface EmailDeliveryConfig {
  apiKey: string
  from: string
}

export type KilnEnvironment = "dev" | "prod"

const DEFAULT_TRUSTED_ORIGINS = [
  "http://localhost:3000",
  "https://hearth.kiln.site",
  "https://hearth.hearth.orb.local",
] as const
const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)

export function kilnEnvironment(): KilnEnvironment {
  return parseKilnEnvironment(process.env.KILN_ENVIRONMENT)
}

export function kilnGitRepository(): string {
  return resolveKilnGitRepository(process.env.KILN_GIT_REPO)
}

export function kilnBrickCatalogUrl(): string {
  return (
    process.env.KILN_BRICKS_CATALOG_URL?.trim() ||
    kilnGitRepositoryRawUrl(kilnGitRepository(), "apps/bricks/catalog.yml")
  )
}

export function kilnInstallationId(): string {
  const configured = process.env.KILN_INSTALLATION_ID?.trim() || "kiln"
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(configured)) {
    throw new Error(
      "KILN_INSTALLATION_ID must use 1-128 letters, numbers, dots, underscores, or hyphens"
    )
  }
  return configured
}

export function developmentBypassEnabled(): boolean {
  return kilnEnvironment() === "dev"
}

export function betterAuthSecrets(): Array<VersionedSecret> {
  return parseSecretKeyring(process.env.BETTER_AUTH_SECRETS)
}

function parseKilnEnvironment(value: string | undefined): KilnEnvironment {
  const configured = value?.trim().toLowerCase()
  if (!configured) return "prod"
  if (configured === "dev" || configured === "prod") return configured
  throw new Error("KILN_ENVIRONMENT must be dev or prod")
}

export function kilnPublicUrl(): URL {
  const configured = process.env.KILN_URL?.trim() || "http://localhost:3000"
  return Option.getOrThrowWith(
    decodeUrl(configured),
    () => new Error("KILN_URL must be an absolute http or https URL")
  )
}

export function kilnRootDomain(): string {
  return rootDomainForHostname(kilnPublicUrl().hostname)
}

export function betterAuthUrl(): URL {
  const configured = process.env.BETTER_AUTH_URL?.trim()
  if (!configured) return kilnPublicUrl()
  return Option.getOrThrowWith(
    decodeUrl(configured),
    () => new Error("BETTER_AUTH_URL must be an absolute http or https URL")
  )
}

export function publicSignupEnabled(): boolean {
  return environmentFlag("KILN_ENABLE_SIGNUPS", false)
}

export function cliDefaultAccessDays(): number {
  const configured = process.env.KILN_CLI_DEFAULT_ACCESS_DAYS?.trim()
  if (!configured) return 30
  const days = Number(configured)
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error(
      "KILN_CLI_DEFAULT_ACCESS_DAYS must be an integer from 1 to 365"
    )
  }
  return days
}

export function emailDeliveryConfig(): EmailDeliveryConfig | null {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const from = process.env.RESEND_FROM_EMAIL?.trim()
  return apiKey && from ? { apiKey, from } : null
}

export function parseTrustedOrigins(
  ...baseOrigins: Array<string>
): Array<string> {
  const configured = process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
  return Array.from(
    new Set([...baseOrigins, ...DEFAULT_TRUSTED_ORIGINS, ...(configured ?? [])])
  )
}

export function relayKey(): string | null {
  return process.env.KILN_RELAY_KEY?.trim() || null
}

export function browserCapabilityMinimumVersion(
  kind: "console" | "file" | "resources"
): 1 | 2 {
  const name = `KILN_BROWSER_CAPABILITY_${kind.toUpperCase()}_MIN_VERSION`
  const value = process.env[name]?.trim() || "1"
  if (value === "1" || value === "2") return Number(value) as 1 | 2
  throw new Error(`${name} must be 1 or 2`)
}

function environmentFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim()
  if (!value) return fallback
  if (/^(?:1|true|yes|on)$/iu.test(value)) return true
  if (/^(?:0|false|no|off)$/iu.test(value)) return false
  throw new Error(`${name} must be true or false`)
}
