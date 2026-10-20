import { resolve } from "node:path"

import { defineConfig, lazyPlugins } from "vite-plus"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const contractsSource = resolve(
  import.meta.dirname,
  "../../packages/contracts/src/index.ts"
)

// The marketing site for kiln.site. Its demos render Hearth's own console and
// editor from apps/web/src, so `@/` resolves there and site code uses `~/`.
const config = defineConfig(({ command }) => ({
  run: {
    tasks: {
      build: {
        command: "vp build",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
      typecheck: {
        command: "tsc --noEmit",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
    },
  },
  envDir: "../..",
  resolve: {
    alias:
      command === "serve"
        ? [{ find: /^@workspace\/contracts$/, replacement: contractsSource }]
        : [],
    // Hearth's components resolve React from apps/web; keep one copy.
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
  plugins: lazyPlugins(() => [tailwindcss(), tanstackStart(), viteReact()]),
}))

export default config
