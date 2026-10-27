// The docs' one address for each page: the home with a trailing slash
// (`/docs/`), every other page without (`/docs/relays/add`). Anything else
// redirects there for good, before Vite or the router sees it. Shared by the
// dev server (vite.config.ts) and the production server (serve.mjs).

/**
 * @param {URL} url
 * @param {string} basePath The base path without a trailing slash, like "/docs".
 * @returns {string | null} Where to send the request, or null to serve it.
 */
export function docsRedirect(url, basePath) {
  const { pathname, search } = url
  if (basePath && pathname === basePath) return `${basePath}/${search}`
  if (
    pathname.startsWith(`${basePath}/`) &&
    pathname.length > basePath.length + 1 &&
    pathname.endsWith("/")
  ) {
    return `${pathname.replace(/\/+$/, "")}${search}`
  }
  return null
}
