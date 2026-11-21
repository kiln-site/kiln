import {
  CommonActions,
  type NavigationProp,
  type NavigationState,
} from "@react-navigation/native"
import type { SFSymbol } from "expo-symbols"

import {
  INFRA_PAGES,
  MANAGE_PAGES,
  SERVER_PAGES,
  managePages,
  sectionLabel,
  showSection,
  type RootStackParamList,
  type SectionParams,
} from "./navigation"

/** The page under any sheet: what the bar and its drawers describe. */
export type ContentRoute =
  | {
      readonly key: string
      readonly name: "Section"
      readonly params: SectionParams
    }
  | {
      readonly key: string
      readonly name: "Server"
      readonly params: RootStackParamList["Server"]
    }
  | {
      readonly key: string
      readonly name: "Relay"
      readonly params: RootStackParamList["Relay"]
    }

export type Tab = "home" | "infra" | "manage"
/** A drawer: a tab's pages, or the pages of what's on screen. */
export type DrawerKind = "infra" | "manage" | "context"

export interface DrawerItem {
  readonly id: string
  readonly title: string
  readonly symbol: SFSymbol
  readonly selected: boolean
}

export interface Drawer {
  readonly title: string
  readonly items: readonly DrawerItem[]
}

type Navigation = Pick<NavigationProp<RootStackParamList>, "dispatch">

const CONTENT_ROUTES = new Set(["Section", "Server", "Relay"])

/** The top page under any sheet, in a root stack's state. */
export function contentRouteOf(
  state: NavigationState | undefined
): ContentRoute | null {
  const route = state?.routes.findLast((entry) =>
    CONTENT_ROUTES.has(entry.name)
  )
  return (route as ContentRoute | undefined) ?? null
}

export const TABS = [
  { id: "home", title: "Home", systemImage: "house" },
  { id: "infra", title: "Infra", systemImage: "square.stack.3d.up" },
  { id: "manage", title: "Manage", systemImage: "switch.2" },
] as const satisfies readonly {
  id: Tab
  title: string
  systemImage: SFSymbol
}[]

/** The tab a page belongs to: game servers and Relays live under Infra. */
export function tabOf(route: ContentRoute): Tab {
  return route.name === "Section" ? route.params.area : "infra"
}

/** The circle's drawer: the pages of whatever is on screen, if it has any. */
export function contextDrawer(
  route: ContentRoute
): (Drawer & { readonly symbol: SFSymbol }) | null {
  if (route.name === "Server") {
    const current = SERVER_PAGES.find((page) => page.id === route.params.page)
    return {
      title: route.params.name,
      symbol: current?.symbol ?? "ellipsis",
      items: SERVER_PAGES.map((page) => ({
        id: `page:${page.id}`,
        title: page.label,
        symbol: page.symbol,
        selected: page.id === route.params.page,
      })),
    }
  }
  if (route.name === "Section" && route.params.area === "manage") {
    const pages = managePages(route.params.page)
    if (pages.length === 0) return null
    const { sub } = route.params
    const current = pages.find((page) => page.id === sub) ?? pages[0]
    return {
      title: sectionLabel(route.params),
      symbol: current?.symbol ?? "ellipsis",
      items: pages.map((page) => ({
        id: `sub:${page.id}`,
        title: page.label,
        symbol: page.symbol,
        selected: page.id === current?.id,
      })),
    }
  }
  return null
}

export function drawerFor(
  kind: DrawerKind,
  route: ContentRoute
): Drawer | null {
  if (kind === "context") return contextDrawer(route)
  const infraPage =
    route.name === "Server"
      ? "servers"
      : route.name === "Relay"
        ? "relays"
        : route.params.area === "infra"
          ? route.params.page
          : null
  const managePage =
    route.name === "Section" && route.params.area === "manage"
      ? route.params.page
      : null
  return kind === "infra"
    ? {
        title: "Infrastructure",
        items: INFRA_PAGES.map((page) => ({
          id: `infra:${page.id}`,
          title: page.label,
          symbol: page.symbol,
          selected: page.id === infraPage,
        })),
      }
    : {
        title: "Manage",
        items: MANAGE_PAGES.map((page) => ({
          id: `manage:${page.id}`,
          title: page.label,
          symbol: page.symbol,
          selected: page.id === managePage,
        })),
      }
}

/**
 * Goes where a drawer item points: another top-level page, or another page of
 * what's on screen. Either way the drawer closes.
 */
export function openDrawerItem(
  navigation: Navigation,
  route: ContentRoute,
  id: string
) {
  const [kind, value = ""] = id.split(":")
  if (kind === "infra") {
    const page = INFRA_PAGES.find((entry) => entry.id === value)
    if (page) showSection(navigation, { area: "infra", page: page.id })
  } else if (kind === "manage") {
    const page = MANAGE_PAGES.find((entry) => entry.id === value)
    if (page)
      showSection(navigation, {
        area: "manage",
        page: page.id,
        sub: page.pages[0]?.id,
      })
  } else {
    navigation.dispatch({
      ...CommonActions.setParams(
        kind === "page" ? { page: value } : { sub: value }
      ),
      source: route.key,
    })
    navigation.dispatch(CommonActions.goBack())
  }
}
