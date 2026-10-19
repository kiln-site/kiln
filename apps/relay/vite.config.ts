import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { Result } from "effect"
import { defineConfig } from "vite-plus"

const repositoryRoot = resolve(import.meta.dirname, "../..")
const buildCommit = resolveBuildCommit()
const release = JSON.parse(
  readFileSync(resolve(repositoryRoot, "release.json"), "utf8")
) as { releaseLine: string }
const buildVersion = process.env.KILN_VERSION?.trim() || release.releaseLine
// Baked as telemetry defaults; see packages/telemetry.
const telemetryEnvironment = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_TRACES_EXPORTER",
  "OTEL_TRACES_SAMPLER_ARG",
]

export default defineConfig({
  pack: {
    define: {
      "import.meta.env.KILN_BUILD_SHA": JSON.stringify(buildCommit),
      "import.meta.env.KILN_VERSION": JSON.stringify(buildVersion),
      // Kept out of import.meta.env, matching Hearth, where that object
      // reaches browser bundles.
      __KILN_TELEMETRY_DEFAULTS__: JSON.stringify(
        Object.fromEntries(
          telemetryEnvironment.map((name) => [
            name,
            process.env[name]?.trim() ?? "",
          ])
        )
      ),
    },
    deps: {
      // tsdown <0.23 compatibility: resolve external dependency subpaths.
      // Remove to preserve subpath imports as written (the new default).
      // https://tsdown.dev/options/dependencies#deps-resolvedepsubpath
      resolveDepSubpath: true,
      // Bundle the workspace packages while production dependencies stay in
      // the separately cached runtime layer.
      alwaysBundle: [
        "@workspace/contracts",
        "@workspace/contracts/schedules",
        "@workspace/telemetry",
      ],
      onlyBundle: ["cron-parser", "luxon"],
    },
    // Named so outputs keep their dist/src paths: older Relays start
    // dist/src/updater.mjs from a new image during self-update.
    entry: {
      "src/index": "src/index.ts",
      "src/updater": "src/updater.ts",
      "src/host-files-helper": "src/host-files-helper.ts",
      "src/database-browser-worker": "src/database-browser-worker.ts",
    },
    format: "esm",
    minify: true,
    outDir: "dist",
    platform: "node",
    sourcemap: true,
    target: "node24",
  },
  run: {
    tasks: {
      build: {
        command: "vp pack",
        dependsOn: [{ task: "build", from: "dependencies" }],
        cache: {
          env: [
            "COMMIT_SHA",
            "GITHUB_SHA",
            "KILN_BUILD_SHA",
            "KILN_VERSION",
            "OTEL_*",
            "SOURCE_COMMIT",
          ],
        },
      },
      test: {
        command: "vp test run",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
      typecheck: {
        command: "tsc --noEmit",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
})

function resolveBuildCommit(): string {
  const configured = [
    process.env.KILN_BUILD_SHA,
    process.env.GITHUB_SHA,
    process.env.COMMIT_SHA,
    process.env.SOURCE_COMMIT,
  ]
    .find((value) => value?.trim())
    ?.trim()

  if (configured) return configured

  return Result.getOrElse(
    Result.try(() => {
      const head = readFileSync(
        resolve(repositoryRoot, ".git/HEAD"),
        "utf8"
      ).trim()
      if (!head.startsWith("ref: ")) return head

      const reference = head.slice(5)
      return Result.getOrElse(
        Result.try(() =>
          readFileSync(
            resolve(repositoryRoot, `.git/${reference}`),
            "utf8"
          ).trim()
        ),
        () => {
          const packedReferences = readFileSync(
            resolve(repositoryRoot, ".git/packed-refs"),
            "utf8"
          )
          return (
            packedReferences
              .split("\n")
              .find((line) => line.endsWith(` ${reference}`))
              ?.split(" ")[0] ?? ""
          )
        }
      )
    }),
    () => ""
  )
}
