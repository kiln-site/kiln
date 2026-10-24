import { Option, Schema } from "effect"

import {
  DEFAULT_KILN_GIT_REPO,
  isKilnInstallationId,
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
  return resolveKilnGitRepository(
    process.env.KILN_GIT_REPO || process.env.KILN_DEFAULT_GIT_REPO
  )
}

export interface KilnLegalUrls {
  privacy: string
  terms: string
}

/**
 * Where the panel's Terms of Use and Privacy Policy links go: the site
 * KILN_MARKETING_URL names, or Kiln's website on official images, since
 * they send QuartzDev telemetry. A fork's panel links to a page saying Kiln
 * doesn't run it, naming the panel it came from.
 */
export function kilnLegalUrls(): KilnLegalUrls {
  const configured = webUrl(process.env.KILN_MARKETING_URL)
  const site = configured
    ? configured.href.replace(/\/+$/u, "")
    : kilnGitRepository() === DEFAULT_KILN_GIT_REPO
      ? "https://kiln.site"
      : null
  if (site) return { privacy: `${site}/privacy`, terms: `${site}/terms` }
  const notice = new URL("https://kiln.site/forks-legal")
  const panel = webUrl(process.env.KILN_URL)
  if (panel) notice.searchParams.set("from", panel.origin)
  return { privacy: notice.href, terms: notice.href }
}

/** Kiln's install script, from KILN_MARKETING_URL's site or Kiln's own. */
export function kilnInstallScriptUrl(): string {
  const configured = webUrl(process.env.KILN_MARKETING_URL)
  return `${configured ? configured.href.replace(/\/+$/u, "") : "https://kiln.site"}/install`
}

// An http or https address, so a link built from it can't run script.
function webUrl(value: string | undefined): URL | null {
  const trimmed = value?.trim()
  if (!trimmed || !URL.canParse(trimmed)) return null
  const url = new URL(trimmed)
  return url.protocol === "https:" || url.protocol === "http:" ? url : null
}

export function kilnBrickCatalogUrl(): string {
  return (
    process.env.KILN_BRICKS_CATALOG_URL?.trim() ||
    kilnGitRepositoryRawUrl(kilnGitRepository(), "apps/bricks/catalog.yml")
  )
}

/**
 * The installation ID an operator set explicitly. Without one, Hearth
 * generates and saves its own (see `effect/installation.ts`).
 */
export function configuredKilnInstallationId(): string | null {
  const configured = process.env.KILN_INSTALLATION_ID?.trim()
  if (!configured) return null
  if (!isKilnInstallationId(configured)) {
    throw new Error(
      "KILN_INSTALLATION_ID must use 1-120 letters, numbers, dots, underscores, or hyphens"
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

// How long a database terminal keeps running with no page open to it.
export function databaseTerminalIdleTimeoutMs(): number {
  const configured =
    process.env.KILN_DATABASE_TERMINAL_IDLE_TIMEOUT_MINUTES?.trim()
  if (!configured) return 15 * 60_000
  const minutes = Number(configured)
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) {
    throw new Error(
      "KILN_DATABASE_TERMINAL_IDLE_TIMEOUT_MINUTES must be an integer from 1 to 1440"
    )
  }
  return minutes * 60_000
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
