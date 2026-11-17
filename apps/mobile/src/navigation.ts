import { CommonActions, type NavigationProp } from "@react-navigation/native"
import type { SFSymbol } from "expo-symbols"

interface Destination<TId extends string> {
  readonly id: TId
  readonly label: string
  readonly symbol: SFSymbol
}

// Mirrors Hearth's navigation (apps/web/src/lib/navigation-destinations.ts)
// so a page sits in the same place on the phone as in the browser.
// Hearth's Infra › Overview is the app's Home tab instead.
export const INFRA_PAGES = [
  {
    id: "relays",
    label: "Relays",
    symbol: "antenna.radiowaves.left.and.right",
  },
  { id: "servers", label: "Game Servers", symbol: "server.rack" },
  { id: "databases", label: "Databases", symbol: "cylinder" },
  { id: "apps", label: "Apps", symbol: "cube" },
  {
    id: "tunnels",
    label: "Tunnels",
    symbol: "point.3.connected.trianglepath.dotted",
  },
  { id: "domains", label: "Domains", symbol: "globe" },
  { id: "sources", label: "Sources", symbol: "arrow.triangle.branch" },
  { id: "deployments", label: "Deployments", symbol: "paperplane" },
] as const satisfies readonly Destination<string>[]

const AUTOMATION_PAGES = [
  { id: "calendar", label: "Calendar", symbol: "calendar" },
  { id: "schedules", label: "Schedules", symbol: "checklist" },
  { id: "sync", label: "Sync", symbol: "arrow.triangle.2.circlepath" },
  { id: "history", label: "History", symbol: "clock.arrow.circlepath" },
] as const satisfies readonly Destination<string>[]

const BACKUP_PAGES = [
  { id: "runs", label: "Runs", symbol: "clock.arrow.circlepath" },
  {
    id: "destinations",
    label: "Destinations",
    symbol: "externaldrive.badge.icloud",
  },
  { id: "settings", label: "Settings", symbol: "slider.horizontal.3" },
] as const satisfies readonly Destination<string>[]

export const MANAGE_PAGES = [
  {
    id: "automations",
    label: "Automations",
    symbol: "calendar.badge.clock",
    pages: AUTOMATION_PAGES,
  },
  {
    id: "backups",
    label: "Backups",
    symbol: "externaldrive",
    pages: BACKUP_PAGES,
  },
  {
    id: "activity",
    label: "Activity",
    symbol: "list.bullet.rectangle",
    pages: [],
  },
  { id: "access", label: "Access", symbol: "person.2", pages: [] },
] as const satisfies readonly (Destination<string> & {
  readonly pages: readonly Destination<string>[]
})[]

export const SERVER_PAGES = [
  { id: "console", label: "Console", symbol: "apple.terminal" },
  { id: "terminal", label: "Terminal", symbol: "chevron.forward.square" },
  { id: "logs", label: "Logs", symbol: "scroll" },
  { id: "files", label: "Files", symbol: "folder" },
  { id: "startup", label: "Startup", symbol: "power" },
  { id: "network", label: "Network", symbol: "network" },
  { id: "info", label: "Info", symbol: "slider.horizontal.3" },
] as const satisfies readonly Destination<string>[]

export type InfraPage = (typeof INFRA_PAGES)[number]["id"]
export type ManagePage = (typeof MANAGE_PAGES)[number]["id"]
export type ServerPage = (typeof SERVER_PAGES)[number]["id"]

export type SectionParams =
  | { readonly area: "home" }
  | { readonly area: "infra"; readonly page: InfraPage }
  | {
      readonly area: "manage"
      readonly page: ManagePage
      readonly sub?: string
    }

export const HOME: SectionParams = { area: "home" }

// Declared by hand rather than inferred from the static navigator: screens
// navigate by these names, and inferring them from App.tsx would make every
// screen's type depend on the navigator that renders it.
export type RootStackParamList = {
  Connect: undefined
  /** A top-level page: Home, always the stack's root, or one picked from a menu. */
  Section: SectionParams
  Server: {
    readonly relayId: string
    readonly instanceId: string
    readonly name: string
    readonly page: ServerPage
  }
  Relay: { readonly relayId: string; readonly name: string }
  Account: undefined
  Search: undefined
  /** A sheet of pages: a tab's, or those of the page under it ("context"). */
  Drawer: { readonly kind: "infra" | "manage" | "context" }
}

export function sectionLabel(params: SectionParams): string {
  if (params.area === "home") return "Home"
  const pages: readonly Destination<string>[] =
    params.area === "infra" ? INFRA_PAGES : MANAGE_PAGES
  return pages.find((page) => page.id === params.page)?.label ?? ""
}

/** A page's title in the header: a Manage page's section, if it has one. */
export function pageTitle(params: SectionParams): string {
  if (params.area !== "manage") return sectionLabel(params)
  return (
    managePages(params.page).find((page) => page.id === params.sub)?.label ??
    sectionLabel(params)
  )
}

export function managePages(page: ManagePage): readonly Destination<string>[] {
  return MANAGE_PAGES.find((entry) => entry.id === page)?.pages ?? []
}

/**
 * Shows a top-level page, as picking it from the bar does. Home is always the
 * bottom of the stack: another page goes on top of it, replacing whatever was
 * open, so back and the back swipe always end on Home.
 */
export function showSection(
  navigation: Pick<NavigationProp<RootStackParamList>, "dispatch">,
  params: SectionParams
) {
  navigation.dispatch((state) => {
    const root = state.routes[0]
    const home =
      root?.name === "Section"
        ? { ...root, params: HOME }
        : { name: "Section" as const, params: HOME }
    const routes =
      params.area === "home"
        ? [home]
        : [home, { name: "Section" as const, params }]
    return CommonActions.reset({ ...state, index: routes.length - 1, routes })
  })
}

declare global {
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
