// The docs' base path with no trailing slash, like "/docs", or "" at the root.
export const basePath = import.meta.env.BASE_URL.replace(/\/$/, "")

// A docs path like "/relays/add" as a URL path on this site.
export function withBase(path: string): string {
  return `${basePath}${path}` || "/"
}

// Where a page's Markdown is served. The docs' home, "/", is "/markdown/index".
export function markdownPath(path: string): string {
  return `/markdown${path === "/" ? "/index" : path}`
}
