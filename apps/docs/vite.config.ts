import { resolve } from "node:path"

import { defineConfig, lazyPlugins } from "vite-plus"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

import { docsContent } from "./content-plugin"
import { docsRedirect } from "./scripts/redirects.mjs"

// Kiln's docs. They're served under a path on kiln.site, `/docs` unless
// KILN_DOCS_BASE_PATH says otherwise when building; every route and asset
// lives below it. Start reads the router's base path from Vite's.
const basePath = (process.env.KILN_DOCS_BASE_PATH ?? "/docs").replace(
  /^\/+|\/+$/g,
  ""
)
const base = basePath ? `/${basePath}/` : "/"

const config = defineConfig(({ command }) => ({
  base,
  run: {
    tasks: {
      build: {
        command: "vp build",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
      typecheck: {
        command: "node ../../scripts/typecheck.mjs",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
    },
  },
  envDir: "../..",
  resolve: {
    // Walkthroughs draw with Hearth's own components from apps/web/src
    // (`@/`), as the marketing site's demos do. Keep one copy of React.
    alias:
      command === "serve"
        ? [
            {
              find: /^@workspace\/contracts$/,
              replacement: resolve(
                import.meta.dirname,
                "../../packages/contracts/src/index.ts"
              ),
            },
          ]
        : [],
    dedupe: ["react", "react-dom"],
    tsconfigPaths: true,
  },
  ssr: command === "serve" ? {} : { noExternal: true },
  server: {
    // Lets a phone on the same tailnet open the dev server by MagicDNS name.
    allowedHosts: [".ts.net"],
    forwardConsole: false,
    host: "0.0.0.0",
  },
  plugins: lazyPlugins(() => [
    {
      // The same redirects as production, ahead of Vite's own handling of
      // the base path.
      name: "kiln-docs:redirects",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? "/", "http://localhost")
          const location = docsRedirect(url, base.replace(/\/$/, ""))
          if (!location) return next()
          response.statusCode = 308
          response.setHeader("Location", location)
          response.end()
        })
      },
    },
    docsContent(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ]),
}))

export default config
