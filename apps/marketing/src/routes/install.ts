import { createFileRoute } from "@tanstack/react-router"

import script from "../../install.sh?raw"

// `curl -fsSL https://kiln.site/install | sh` installs Kiln (see
// docs/self-hosting.md). The script is bundled at build time, so kiln.site
// serves the version from the commit it deployed. Plain text, so a browser
// shows it to read before running.
const INSTALL_HEADERS = {
  "Cache-Control": "public, max-age=300",
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const

export const Route = createFileRoute("/install")({
  server: {
    handlers: {
      GET: () => new Response(script, { headers: INSTALL_HEADERS }),
    },
  },
})
