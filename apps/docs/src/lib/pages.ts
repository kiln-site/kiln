import manifest from "virtual:docs/manifest"

import type { CompiledPage } from "../../content-plugin"
import { navigation, type NavigationSection } from "~/content/navigation"

export interface PageSummary {
  description: string
  path: string
  title: string
}

export interface NavigationEntry extends PageSummary {
  section: NavigationSection
}

const summaries = new Map(manifest.map((page) => [page.path, page]))

// Each page is its own chunk, loaded when it's opened.
const modules = import.meta.glob<{ default: CompiledPage }>("/content/**/*.md")
const loaders = new Map(
  Object.entries(modules).map(([file, load]) => [
    file
      .replace(/^\/content/, "")
      .replace(/\.md$/, "")
      .replace(/\/index$/, "") || "/",
    load,
  ])
)

export async function loadPage(path: string): Promise<CompiledPage | null> {
  const load = loaders.get(path)
  return load ? (await load()).default : null
}

export function pageSummary(path: string): PageSummary | undefined {
  return summaries.get(path)
}

// The sidebar's sections with only the pages that exist.
export const sections: Array<
  NavigationSection & { entries: Array<NavigationEntry> }
> = navigation
  .map((section) => ({
    ...section,
    entries: section.pages.flatMap((path) => {
      const page = summaries.get(path)
      return page ? [{ ...page, section }] : []
    }),
  }))
  .filter((section) => section.entries.length > 0)

// Every page in sidebar order, for previous and next.
export const orderedPages: Array<NavigationEntry> = sections.flatMap(
  (section) => section.entries
)

export function sectionOf(path: string): NavigationSection | undefined {
  return orderedPages.find((page) => page.path === path)?.section
}

export function neighbours(path: string): {
  next: NavigationEntry | undefined
  previous: NavigationEntry | undefined
} {
  const index = orderedPages.findIndex((page) => page.path === path)
  if (index === -1) return { next: undefined, previous: undefined }
  return { next: orderedPages[index + 1], previous: orderedPages[index - 1] }
}
