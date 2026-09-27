import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { Result } from "effect"
import { defineConfig, lazyPlugins } from "vite-plus"
import type { Plugin } from "vite-plus"
import { sentryTanstackStart } from "@sentry/tanstackstart-react/vite"
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

const config = defineConfig(({ command }) => {
  const sourceCommit = resolveBuildCommit()
  const buildCommit = command === "serve" ? "" : sourceCommit
  const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN
  const sentrySourceMaps = process.env.SENTRY_SOURCEMAPS
  const configureSentry =
    Boolean(sentryAuthToken) || sentrySourceMaps === "prepare"

  return {
    build: sentrySourceMaps === "prepare" ? { sourcemap: "hidden" } : undefined,
    run: {
      tasks: {
        build: {
          command: [
            "vp build",
            "node scripts/normalize-build-assets.mjs",
            "vp pack",
          ],
          dependsOn: [{ task: "build", from: "dependencies" }],
          env: [
            "COMMIT_SHA",
            "GITHUB_SHA",
            "KILN_BUILD_SHA",
            "KILN_VERSION",
            "SENTRY_AUTH_TOKEN",
            "SENTRY_SOURCEMAPS",
            "SOURCE_COMMIT",
          ],
        },
        test: {
          command: ["vp test run", "node --test keyring.test.mjs"],
          dependsOn: [{ task: "build", from: "dependencies" }],
        },
        typecheck: {
          command: "tsc --noEmit",
          dependsOn: [{ task: "build", from: "dependencies" }],
        },
      },
    },
    pack: {
      clean: false,
      deps: {
        alwaysBundle: [
          "@opentelemetry/api",
          "@opentelemetry/core",
          "@sentry/tanstackstart-react",
        ],
        onlyBundle: false,
      },
      entry: ["instrument.server.mjs"],
      format: "esm",
      minify: true,
      outDir: "dist/instrument",
      platform: "node",
      target: "node24",
    },
    define: {
      "import.meta.env.VITE_KILN_BUILD_SHA": JSON.stringify(buildCommit),
      "import.meta.env.VITE_KILN_SOURCE_SHA": JSON.stringify(sourceCommit),
      "import.meta.env.VITE_KILN_VERSION": JSON.stringify(
        process.env.KILN_VERSION?.trim() || release.releaseLine
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
      ...(configureSentry
        ? [
            sentryTanstackStart({
              org: "quartzdev",
              project: "kiln",
              authToken: sentryAuthToken,
              sourcemaps:
                sentrySourceMaps === "prepare"
                  ? { disable: "disable-upload" }
                  : undefined,
              silent: !sentryAuthToken,
              telemetry: false,
            }),
          ]
        : []),
      viteReact(),
    ]),
    test: {
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
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
