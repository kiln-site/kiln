import {
  CommonActions,
  type NavigationContainerRef,
} from "@react-navigation/native"
import * as Haptics from "expo-haptics"
import type { SFSymbol } from "expo-symbols"
import { useState, type ReactElement } from "react"
import { Modal, Pressable, View, useColorScheme, type ViewStyle } from "react-native"

import {
  NativeNavBar,
  type NavContext,
  type NavItem,
  type NavSection,
} from "../../modules/kiln-native"
import { cn } from "../lib/cn"
import { usePalette } from "../lib/palette"
import {
  INFRA_PAGES,
  MANAGE_PAGES,
  SERVER_PAGES,
  managePages,
  sectionLabel,
  showSection,
  type InfraPage,
  type ManagePage,
  type RootStackParamList,
  type SectionParams,
} from "../navigation"
import { BAR_HEIGHT, useBarFrame, useKeyboardOpen } from "./chrome"
import { AppText, Icon } from "./ui"

/** The page under any sheet: what the bar describes and acts on. */
export type ContentRoute =
  | { readonly key: string; readonly name: "Section"; readonly params: SectionParams }
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

type Navigation = NavigationContainerRef<RootStackParamList>

function infraPageOf(route: ContentRoute): InfraPage | null {
  if (route.name === "Server") return "servers"
  if (route.name === "Relay") return "relays"
  return route.params.area === "infra" ? route.params.page : null
}

function managePageOf(route: ContentRoute): ManagePage | null {
  return route.name === "Section" && route.params.area === "manage"
    ? route.params.page
    : null
}

function sectionsFor(route: ContentRoute): NavSection[] {
  const infraPage = infraPageOf(route)
  const managePage = managePageOf(route)
  return [
    {
      id: "infra",
      title: "Infra",
      menuTitle: "Infrastructure",
      systemImage: "square.stack.3d.up",
      items: INFRA_PAGES.map((page) => ({
        id: `infra:${page.id}`,
        title: page.label,
        systemImage: page.symbol,
        selected: page.id === infraPage,
      })),
    },
    {
      id: "manage",
      title: "Manage",
      menuTitle: "Manage",
      systemImage: "switch.2",
      items: MANAGE_PAGES.map((page) => ({
        id: `manage:${page.id}`,
        title: page.label,
        systemImage: page.symbol,
        selected: page.id === managePage,
      })),
    },
  ]
}

/** The circle's menu: the pages of whatever is on screen, if it has any. */
function contextFor(route: ContentRoute): NavContext | null {
  if (route.name === "Server") {
    const current = SERVER_PAGES.find((page) => page.id === route.params.page)
    return {
      title: route.params.name,
      systemImage: current?.symbol ?? "ellipsis",
      items: SERVER_PAGES.map((page) => ({
        id: `page:${page.id}`,
        title: page.label,
        systemImage: page.symbol,
        selected: page.id === route.params.page,
      })),
    }
  }
  if (route.name === "Section" && route.params.area === "manage") {
    const { sub } = route.params
    const pages = managePages(route.params.page)
    if (pages.length === 0) return null
    const current = pages.find((page) => page.id === sub) ?? pages[0]
    return {
      title: sectionLabel(route.params),
      systemImage: current?.symbol ?? "ellipsis",
      items: pages.map((page) => ({
        id: `sub:${page.id}`,
        title: page.label,
        systemImage: page.symbol,
        selected: page.id === current?.id,
      })),
    }
  }
  return null
}

function select(navigation: Navigation, route: ContentRoute, id: string) {
  const [kind, value = ""] = id.split(":")
  void Haptics.selectionAsync()
  const setParams = (params: object) =>
    navigation.dispatch({ ...CommonActions.setParams(params), source: route.key })

  if (kind === "infra") {
    const page = INFRA_PAGES.find((entry) => entry.id === value)
    if (page) showSection(navigation, { area: "infra", page: page.id })
  } else if (kind === "manage") {
    const page = MANAGE_PAGES.find((entry) => entry.id === value)
    if (page)
      showSection(navigation, { area: "manage", page: page.id, sub: page.pages[0]?.id })
  } else if (kind === "page") {
    setParams({ page: value })
  } else if (kind === "sub") {
    setParams({ sub: value })
  }
}

export function NavBar(props: {
  readonly navigation: Navigation
  readonly route: ContentRoute
}): ReactElement | null {
  const palette = usePalette()
  const scheme = useColorScheme()
  const frame = useBarFrame()
  // The bar would sit on the keyboard; inputs above it take its place.
  if (useKeyboardOpen()) return null

  const sections = sectionsFor(props.route)
  const selectedSection =
    props.route.name === "Section" ? props.route.params.area : "infra"
  const context = contextFor(props.route)
  const onSelect = (id: string) => select(props.navigation, props.route, id)
  const style: ViewStyle = {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: frame.bottom,
    height: BAR_HEIGHT,
  }

  if (NativeNavBar) {
    return (
      <NativeNavBar
        style={style}
        pointerEvents="box-none"
        sections={sections}
        selectedSection={selectedSection}
        context={context}
        tint={palette.primaryText}
        appearance={scheme === "light" ? "light" : "dark"}
        onSelect={(event) => onSelect(event.nativeEvent.id)}
      />
    )
  }
  return (
    <FallbackNavBar
      style={style}
      sections={sections}
      selectedSection={selectedSection}
      context={context}
      onSelect={onSelect}
    />
  )
}

/** Android: the same bar drawn in React Native, with sheet menus. */
function FallbackNavBar(props: {
  readonly style: ViewStyle
  readonly sections: readonly NavSection[]
  readonly selectedSection: string
  readonly context: NavContext | null
  readonly onSelect: (id: string) => void
}): ReactElement {
  const [menu, setMenu] = useState<{
    readonly title: string
    readonly items: readonly NavItem[]
  } | null>(null)
  const close = () => setMenu(null)
  return (
    <View
      style={props.style}
      pointerEvents="box-none"
      className="flex-row items-end justify-between"
    >
      <View className="h-full flex-row rounded-full border border-border bg-card p-1">
        {props.sections.map((section) => {
          const selected = section.id === props.selectedSection
          return (
            <Pressable
              key={section.id}
              accessibilityRole="button"
              accessibilityLabel={section.title}
              accessibilityState={{ selected }}
              onPress={() => setMenu({ title: section.menuTitle, items: section.items })}
              className={cn(
                "w-20 items-center justify-center gap-0.5 rounded-full",
                selected && "bg-raised"
              )}
            >
              <Icon
                name={section.systemImage as SFSymbol}
                color={selected ? "primaryText" : "foreground"}
              />
              <AppText
                className={cn("font-medium text-2xs", selected && "text-primary-text")}
              >
                {section.title}
              </AppText>
            </Pressable>
          )
        })}
      </View>
      {props.context ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.context.title} pages`}
          onPress={() =>
            props.context &&
            setMenu({ title: props.context.title, items: props.context.items })
          }
          className="size-[62px] items-center justify-center rounded-full border border-border bg-card"
        >
          <Icon name={props.context.systemImage as SFSymbol} size={20} />
        </Pressable>
      ) : null}
      <Modal visible={menu !== null} transparent animationType="fade" onRequestClose={close}>
        <Pressable className="flex-1 justify-end bg-black/50 p-3" onPress={close}>
          <View className="border border-border bg-card py-2">
            <AppText className="px-4 pb-2 pt-1 font-mono-medium text-2xs uppercase tracking-widest text-foreground-muted">
              {menu?.title}
            </AppText>
            {menu?.items.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                onPress={() => {
                  close()
                  props.onSelect(item.id)
                }}
                className="min-h-12 flex-row items-center gap-3 px-4 active:bg-raised"
              >
                <Icon
                  name={item.systemImage as SFSymbol}
                  color={item.selected ? "primaryText" : "muted"}
                />
                <AppText
                  className={cn("flex-1 text-base", item.selected && "text-primary-text")}
                >
                  {item.title}
                </AppText>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  )
}
