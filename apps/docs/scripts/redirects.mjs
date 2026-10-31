// The docs' one address for each page: the home with a trailing slash
// (`/docs/`), every other page without (`/docs/relays/add`). Anything else,
// and a page that moved, redirects there for good, before Vite or the router
// sees it. Shared by the dev server (vite.config.ts) and the production server
// (serve.mjs).

// Old docs paths and where they moved, without the base path.
const moved = {
  "/get-started/introduction": "/",
  "/get-started/install": "/#install",
  "/get-started/concepts": "/#how-kiln-fits-together",
  "/get-started/first-game-server": "/game-servers",
  "/get-started/first-app": "/apps",
  "/game-servers/create": "/game-servers",
  "/game-servers/startup": "/game-servers#startup-settings",
  "/game-servers/power": "/game-servers#power-controls",
  "/game-servers/console": "/game-servers/console-and-files",
  "/game-servers/files": "/game-servers/console-and-files",
  "/apps/github": "/apps",
  "/apps/images-and-compose": "/apps",
  "/apps/updates": "/apps/settings",
  "/databases/create": "/databases",
  "/databases/connect": "/databases",
  "/networking/ports": "/networking#ports",
  "/networking/cloudflare": "/networking#cloudflare",
  "/networking/tailscale": "/networking#tailscale",
  "/relays/add": "/relays",
  "/relays/runtime": "/relays/host",
  "/relays/transfers": "/game-servers/move",
  "/backups/destinations": "/backups",
  "/backups/platform": "/backups/restore",
  "/access/permissions": "/access",
  "/access/activity": "/access",
  "/access/notifications": "/access",
  "/self-hosting/configuration": "/self-hosting#configuration",
  "/self-hosting/recovery": "/self-hosting/updates",
  "/cli/authentication": "/cli",
  "/help/troubleshooting": "/help",
  "/help/faq": "/help",
}

/**
 * @param {URL} url
 * @param {string} basePath The base path without a trailing slash, like "/docs".
 * @returns {string | null} Where to send the request, or null to serve it.
 */
export function docsRedirect(url, basePath) {
  const { pathname, search } = url
  if (basePath && pathname === basePath) return `${basePath}/${search}`
  const page = pathname.slice(basePath.length).replace(/\/+$/, "")
  if (pathname.startsWith(`${basePath}/`) && Object.hasOwn(moved, page)) {
    const [target, anchor] = moved[page].split("#")
    return `${basePath}${target}${search}${anchor ? `#${anchor}` : ""}`
  }
  if (
    pathname.startsWith(`${basePath}/`) &&
    pathname.length > basePath.length + 1 &&
    pathname.endsWith("/")
  ) {
    return `${pathname.replace(/\/+$/, "")}${search}`
  }
  return null
}
