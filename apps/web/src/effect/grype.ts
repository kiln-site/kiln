import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { setPriority, tmpdir } from "node:os"
import { join } from "node:path"

import { Context, Effect, Layer, Semaphore } from "effect"
import { z } from "zod"

import { ExternalServiceError } from "@/effect/errors"
import { ensuringPromise, recoverPromise } from "@/effect/promise"
import { severityRank, type SecuritySeverity } from "@/lib/security"

// Grype, which checks the inventories Relays send against its vulnerability
// database. Hearth runs one Grype at a time, at the lowest CPU priority, and
// keeps its database (about 3 GB, a 200 MB download) in
// KILN_VULNERABILITY_DB_DIR.

const grypePath = () => process.env.KILN_GRYPE_PATH?.trim() || "grype"
const databaseDirectory = () =>
  process.env.KILN_VULNERABILITY_DB_DIR?.trim() ||
  join(tmpdir(), "kiln-vulnerability-db")

const severities: Record<string, SecuritySeverity> = {
  critical: "critical",
  high: "high",
  low: "low",
  medium: "medium",
  negligible: "negligible",
}

/** One vulnerability in one package, as Hearth keeps it. */
export interface GrypeFinding {
  readonly cvss: number | null
  readonly description: string | null
  readonly epss: number | null
  readonly findingKey: string
  readonly fixState: "fixed" | "not-fixed" | "unknown" | "wont-fix"
  readonly fixedVersion: string | null
  readonly knownExploited: boolean
  readonly location: string | null
  readonly packageName: string
  /** The source package it was built from, as `linux` for `linux-image-…`. */
  readonly packageSource: string | null
  readonly packageType: string
  readonly packageVersion: string
  readonly risk: number
  readonly severity: number
  readonly url: string | null
  readonly vulnerabilityId: string
}

const text = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value ? value.slice(0, max) : null))

// The parts of `grype -o json` Hearth reads. Anything else may change.
const grypeOutputSchema = z.object({
  matches: z.array(
    z.object({
      artifact: z.object({
        cpes: z.array(z.string()).nullish(),
        locations: z.array(z.object({ path: z.string() }).loose()).nullish(),
        name: z.string().max(255),
        type: z.string().max(32),
        upstreams: z.array(z.object({ name: z.string() }).loose()).nullish(),
        version: z.string().max(255),
      }),
      matchDetails: z
        .array(
          z
            .object({
              fix: z
                .object({ suggestedVersion: z.string().nullish() })
                .loose()
                .nullish(),
            })
            .loose()
        )
        .nullish(),
      vulnerability: z.object({
        cvss: z
          .array(
            z
              .object({
                metrics: z.object({ baseScore: z.number() }).loose(),
              })
              .loose()
          )
          .nullish(),
        dataSource: text(1024),
        description: text(4000),
        epss: z.array(z.object({ epss: z.number() }).loose()).nullish(),
        fix: z
          .object({
            state: z.string().nullish(),
            versions: z.array(z.string()).nullish(),
          })
          .loose()
          .nullish(),
        id: z.string().min(1).max(64),
        knownExploited: z.array(z.unknown()).nullish(),
        risk: z.number().nullish(),
        severity: z.string().nullish(),
      }),
    })
  ),
})

/** Hearth's findings from Grype's JSON output, one per vulnerable package. */
export function grypeFindings(output: unknown): Array<GrypeFinding> {
  const parsed = grypeOutputSchema.parse(output)
  const findings = new Map<string, GrypeFinding>()
  for (const match of parsed.matches) {
    const { artifact, vulnerability } = match
    const findingKey = createHash("sha256")
      .update(
        [vulnerability.id, artifact.name, artifact.version, artifact.type].join(
          "\u0000"
        )
      )
      .digest("hex")
    const state = vulnerability.fix?.state
    const fixState =
      state === "fixed" || state === "not-fixed" || state === "wont-fix"
        ? state
        : "unknown"
    const suggested = match.matchDetails?.find(
      (detail) => detail.fix?.suggestedVersion
    )?.fix?.suggestedVersion
    const finding: GrypeFinding = {
      cvss: maximum(
        vulnerability.cvss?.map((entry) => entry.metrics.baseScore) ?? []
      ),
      description: vulnerability.description,
      epss: maximum(vulnerability.epss?.map((entry) => entry.epss) ?? []),
      findingKey,
      fixState,
      fixedVersion:
        fixState === "fixed"
          ? ((suggested ?? vulnerability.fix?.versions?.[0] ?? null)?.slice(
              0,
              255
            ) ?? null)
          : null,
      knownExploited: (vulnerability.knownExploited?.length ?? 0) > 0,
      location: artifact.locations?.[0]?.path.slice(0, 512) ?? null,
      packageName: artifact.name,
      packageSource: packageSource(artifact),
      packageType: artifact.type,
      packageVersion: artifact.version,
      risk: vulnerability.risk ?? 0,
      severity: severityRank(
        severities[vulnerability.severity?.toLowerCase() ?? ""] ?? "negligible"
      ),
      url: vulnerability.dataSource?.startsWith("https://")
        ? vulnerability.dataSource
        : null,
      vulnerabilityId: vulnerability.id,
    }
    const previous = findings.get(findingKey)
    // Matchers can find the same one twice; keep what says most.
    if (!previous || finding.severity > previous.severity) {
      findings.set(findingKey, finding)
    }
  }
  return [...findings.values()]
}

// What a package was built from: the source package a distribution names,
// or for software Syft found by its binary, the product its CPE names, so
// `php-cli` and `php-fpm` from one PHP build are one PHP.
function packageSource(artifact: {
  readonly cpes?: ReadonlyArray<string> | null
  readonly type: string
  readonly upstreams?: ReadonlyArray<{ readonly name: string }> | null
}): string | null {
  const upstream = artifact.upstreams?.[0]?.name
  if (upstream) return upstream.slice(0, 255)
  if (artifact.type !== "binary") return null
  return artifact.cpes?.[0]?.split(":")[4]?.slice(0, 255) || null
}

function maximum(values: ReadonlyArray<number>): number | null {
  return values.length ? Math.max(...values) : null
}

function grypeEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    GRYPE_CHECK_FOR_APP_UPDATE: "false",
    GRYPE_DB_AUTO_UPDATE: "false",
    GRYPE_DB_CACHE_DIR: databaseDirectory(),
    TMPDIR: tmpdir(),
  }
}

// Runs Grype at the lowest priority, collecting its output. Grype is killed
// when `signal` aborts, as when the worker running it is interrupted.
function runGrype(
  args: ReadonlyArray<string>,
  options: { readonly signal: AbortSignal; readonly timeoutMs: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(grypePath(), args, {
      env: grypeEnvironment(),
      killSignal: "SIGKILL",
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    })
    // Priority is a courtesy; a host that refuses it still runs Grype.
    if (child.pid !== undefined) {
      const pid = child.pid
      Effect.runSync(Effect.try(() => setPriority(pid, 19)).pipe(Effect.ignore))
    }
    const stdout: Array<Buffer> = []
    let stderr = ""
    let size = 0
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs)
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 256 * 1024 * 1024) child.kill("SIGKILL")
      else stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000)
    })
    child.on("error", (cause) => {
      clearTimeout(timer)
      reject(cause)
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"))
      else
        reject(
          new Error(
            stderr.trim().split("\n").at(-1) ||
              (signal
                ? `Grype stopped (${signal})`
                : `Grype exited with ${code}`)
          )
        )
    })
  })
}

const failure = (message: string) => (cause: unknown) =>
  ExternalServiceError.make({
    cause,
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    service: "Grype",
  })

export class Grype extends Context.Service<
  Grype,
  {
    /** When the database Grype has was built, or null without one. */
    readonly databaseBuiltAt: () => Effect.Effect<
      number | null,
      ExternalServiceError
    >
    /** Downloads a newer database when there is one. */
    readonly updateDatabase: () => Effect.Effect<void, ExternalServiceError>
    /** Checks a Syft JSON document against the database. */
    readonly match: (
      document: Uint8Array
    ) => Effect.Effect<Array<GrypeFinding>, ExternalServiceError>
  }
>()("kiln/Grype") {
  static readonly layer = Layer.effect(
    Grype,
    Effect.gen(function* () {
      const permit = yield* Semaphore.make(1)
      const databaseBuiltAt = () =>
        Effect.tryPromise({
          try: async (signal) => {
            // Without a database, Grype exits with an error.
            const output = await recoverPromise(
              () =>
                runGrype(["db", "status", "-o", "json"], {
                  signal,
                  timeoutMs: 60_000,
                }),
              () => null
            )
            if (output === null) return null
            const status = z
              .object({ built: z.string(), valid: z.boolean() })
              .loose()
              .safeParse(JSON.parse(output))
            if (!status.success || !status.data.valid) return null
            const built = Date.parse(status.data.built)
            return Number.isFinite(built) ? built : null
          },
          catch: failure("Could not read Grype's database"),
        })
      return Grype.of({
        databaseBuiltAt: () => permit.withPermit(databaseBuiltAt()),
        updateDatabase: () =>
          permit.withPermit(
            Effect.tryPromise({
              try: async (signal) => {
                await mkdir(databaseDirectory(), { recursive: true })
                await runGrype(["db", "update"], {
                  signal,
                  timeoutMs: 30 * 60_000,
                })
              },
              catch: failure("Could not update Grype's database"),
            })
          ),
        match: (document) =>
          permit.withPermit(
            Effect.tryPromise({
              try: async (signal) => {
                const directory = join(databaseDirectory(), "inventories")
                await mkdir(directory, { recursive: true })
                const path = join(directory, `${randomUUID()}.json`)
                await writeFile(path, document)
                const output = await ensuringPromise(
                  () =>
                    runGrype([`sbom:${path}`, "-o", "json", "-q"], {
                      signal,
                      timeoutMs: 10 * 60_000,
                    }),
                  () => void rm(path, { force: true })
                )
                return grypeFindings(JSON.parse(output))
              },
              catch: failure("Could not check an inventory"),
            })
          ),
      })
    })
  )
}

/** Whether Grype is installed where Hearth looks for it. */
export function grypeInstalled(): Promise<boolean> {
  return new Promise((resolve) =>
    execFile(grypePath(), ["version"], { env: grypeEnvironment() }, (error) =>
      resolve(error === null)
    )
  )
}
