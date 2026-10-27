import { defineConfig, lazyPlugins } from "vite-plus"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

import { docsContent } from "./content-plugin"

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
  resolve: { tsconfigPaths: true },
  ssr: command === "serve" ? {} : { noExternal: true },
  server: {
    // Lets a phone on the same tailnet open the dev server by MagicDNS name.
    allowedHosts: [".ts.net"],
    forwardConsole: false,
    host: "0.0.0.0",
  },
  plugins: lazyPlugins(() => [
    docsContent(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ]),
}))

export default config
