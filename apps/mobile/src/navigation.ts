import { CommonActions, type NavigationProp } from "@react-navigation/native"
import type { SFSymbol } from "expo-symbols"

interface Destination<TId extends string> {
  readonly id: TId
  readonly label: string
  readonly symbol: SFSymbol
}

// Mirrors Hearth's navigation (apps/web/src/lib/navigation-destinations.ts)
// so a page sits in the same place on the phone as in the browser.
export const INFRA_PAGES = [
  { id: "overview", label: "Overview", symbol: "square.grid.2x2" },
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
  | { readonly area: "infra"; readonly page: InfraPage }
  | {
      readonly area: "manage"
      readonly page: ManagePage
      readonly sub?: string
    }

export const HOME: SectionParams = { area: "infra", page: "overview" }

// Declared by hand rather than inferred from the static navigator: screens
// navigate by these names, and inferring them from App.tsx would make every
// screen's type depend on the navigator that renders it.
export type RootStackParamList = {
  Connect: undefined
  /** A top-level page, picked from the Infra or Manage menu. Always the root. */
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
}

export function sectionLabel(params: SectionParams): string {
  const pages: readonly Destination<string>[] =
    params.area === "infra" ? INFRA_PAGES : MANAGE_PAGES
  return pages.find((page) => page.id === params.page)?.label ?? ""
}

export function managePages(page: ManagePage): readonly Destination<string>[] {
  return MANAGE_PAGES.find((entry) => entry.id === page)?.pages ?? []
}

/** Switches to a top-level page, as picking it from the bar does. */
export function showSection(
  navigation: Pick<NavigationProp<RootStackParamList>, "dispatch">,
  params: SectionParams
) {
  navigation.dispatch(
    CommonActions.reset({ index: 0, routes: [{ name: "Section", params }] })
  )
}

declare global {
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
