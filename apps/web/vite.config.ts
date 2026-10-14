import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { Result } from "effect"
import { defineConfig, lazyPlugins } from "vite-plus"
import type { Plugin } from "vite-plus"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const repositoryRoot = resolve(import.meta.dirname, "../..")
const release = JSON.parse(
  readFileSync(resolve(repositoryRoot, "release.json"), "utf8")
) as { releaseLine: string }
const contractsSource = resolve(
  repositoryRoot,
  "packages/contracts/src/index.ts"
)
const brandingDirectory = resolve(import.meta.dirname, "src/assets/branding")
const reactScanProductionShim = resolve(
  import.meta.dirname,
  "node_modules/react-scan/dist/rsc-shim.mjs"
)
// Baked into the server bundle as telemetry defaults; see packages/telemetry.
const telemetryEnvironment = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_TRACES_EXPORTER",
  "OTEL_TRACES_SAMPLER_ARG",
]

const config = defineConfig(({ command }) => {
  const sourceCommit = resolveBuildCommit()
  const buildCommit = command === "serve" ? "" : sourceCommit

  return {
    run: {
      tasks: {
        build: {
          command: ["vp build", "node scripts/normalize-build-assets.mjs"],
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
          cache: {
            // Opt-in real-MySQL suites, see src/test/database.ts.
            env: ["KILN_TEST_MYSQL", "DB_*"],
          },
        },
        typecheck: {
          command: "tsc --noEmit",
          dependsOn: [{ task: "build", from: "dependencies" }],
        },
      },
    },
    define: {
      "import.meta.env.VITE_KILN_BUILD_SHA": JSON.stringify(buildCommit),
      "import.meta.env.VITE_KILN_SOURCE_SHA": JSON.stringify(sourceCommit),
      "import.meta.env.VITE_KILN_VERSION": JSON.stringify(
        process.env.KILN_VERSION?.trim() || release.releaseLine
      ),
      // Not under import.meta.env: that object reaches browser bundles.
      __KILN_TELEMETRY_DEFAULTS__: JSON.stringify(
        Object.fromEntries(
          telemetryEnvironment.map((name) => [
            name,
            process.env[name]?.trim() ?? "",
          ])
        )
      ),
    },
    envDir: "../..",
    resolve: {
      // Keep React Scan's instrumentation and toolbar out of production bundles.
      alias:
        command === "serve"
          ? [
              {
                find: /^@workspace\/contracts$/,
                replacement: contractsSource,
              },
            ]
          : [{ find: /^react-scan$/, replacement: reactScanProductionShim }],
      tsconfigPaths: true,
    },
    ssr: {
      external: ["better-sqlite3", "pg", "tedious"],
      ...(command === "serve" ? {} : { noExternal: true }),
    },
    // Browser errors remain available in devtools and the collaborative preview.
    // Forwarding them back through Vite can recursively re-forward its own output.
    server: {
      allowedHosts: developmentHosts(),
      forwardConsole: false,
      host: "0.0.0.0",
    },
    plugins: lazyPlugins(() => [
      webAppManifest(),
      devtools(),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
    ]),
    test: {
      include: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "scripts/**/*.test.mjs",
        "keyring.test.mjs",
      ],
      setupFiles: ["src/test/setup.ts"],
      // Creating and migrating a fresh per-worker MySQL database takes longer
      // than the default hook timeout.
      hookTimeout: 60_000,
    },
  }
})

export default config

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

// Emits /manifest.json with content-hashed icon URLs so installed apps and
// mobile browsers pick up logo changes instead of keeping a cached icon path.
function webAppManifest(): Plugin {
  const icons = [
    { file: "app-icon-192.png", sizes: "192x192", type: "image/png" },
    { file: "app-icon-512.png", sizes: "512x512", type: "image/png" },
  ]
  const manifest = (iconUrl: (file: string) => string) =>
    JSON.stringify({
      short_name: "Kiln",
      name: "Kiln — Minecraft Control Plane",
      icons: icons.map(({ file, ...icon }) => ({
        src: iconUrl(file),
        ...icon,
        purpose: "any maskable",
      })),
      start_url: "/",
      display: "standalone",
      theme_color: "#e9842b",
      background_color: "#181515",
    })

  return {
    name: "kiln:web-app-manifest",
    configureServer(server) {
      server.middlewares.use("/manifest.json", (_request, response) => {
        response.setHeader("Content-Type", "application/json")
        response.end(manifest((file) => `/src/assets/branding/${file}`))
      })
    },
    generateBundle() {
      if (this.environment.name !== "client") return
      const fileNames = new Map(
        icons.map(({ file }) => [
          file,
          this.getFileName(
            this.emitFile({
              type: "asset",
              name: file,
              source: readFileSync(resolve(brandingDirectory, file)),
            })
          ),
        ])
      )
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: manifest((file) => `/${fileNames.get(file)}`),
      })
    },
  }
}

function developmentHosts(): Array<string> {
  const hosts = new Set(["localhost", "hearth.hearth.orb.local"])
  const configured = process.env.KILN_URL?.trim()
  if (!configured) return [...hosts]
  Result.try(() => {
    hosts.add(new URL(configured).hostname)
  })
  // Application startup reports the invalid KILN_URL with more context.
  return [...hosts]
}
