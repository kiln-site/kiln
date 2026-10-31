// The modules content-plugin.ts builds from content/**/*.md.

declare module "*.md" {
  const page: import("../content-plugin").CompiledPage
  export default page
}

declare module "virtual:docs/manifest" {
  const pages: Array<{ description: string; path: string; title: string }>
  export default pages
}

declare module "virtual:docs/search" {
  const entries: Array<import("../content-plugin").SearchEntry>
  export default entries
}

declare module "virtual:docs/markdown" {
  const pages: Array<{
    description: string
    markdown: string
    path: string
    title: string
  }>
  export default pages
}
