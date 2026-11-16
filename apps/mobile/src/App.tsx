import "../global.css"

import {
  DarkTheme,
  DefaultTheme,
  createNavigationContainerRef,
  createStaticNavigation,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native"
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack"
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query"
import * as SplashScreen from "expo-splash-screen"
import { StatusBar } from "expo-status-bar"
import { useEffect, useState, type ReactElement } from "react"
import {
  AppState,
  Image,
  Platform,
  Pressable,
  View,
  useColorScheme,
} from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"

import { NavBar, type ContentRoute } from "./components/NavBar"
import { AppText, Icon } from "./components/ui"
import { usePalette } from "./lib/palette"
import {
  HOME,
  SERVER_PAGES,
  sectionLabel,
  type RootStackParamList,
} from "./navigation"
import { AccountScreen } from "./screens/AccountScreen"
import { ConnectScreen } from "./screens/ConnectScreen"
import { ConsoleScreen } from "./screens/ConsoleScreen"
import { RelayScreen } from "./screens/RelayScreen"
import { SearchScreen } from "./screens/SearchScreen"
import { NotYet, SectionScreen } from "./screens/SectionScreen"
import { ServerScreen } from "./screens/ServerScreen"
import {
  SessionProvider,
  useIsSignedIn,
  useIsSignedOut,
  useSessionContext,
} from "./session/SessionProvider"

void SplashScreen.preventAutoHideAsync()

// Refetch intervals pause while the app is in the background.
focusManager.setEventListener((setFocused) => {
  const subscription = AppState.addEventListener("change", (state) =>
    setFocused(state === "active")
  )
  return () => subscription.remove()
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 2_000 },
  },
})

const MARK = require("../assets/mark.png")

function Brand(): ReactElement {
  const palette = usePalette()
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel="Kiln"
      className="flex-row items-center gap-2 pr-2"
    >
      <Image
        source={MARK}
        style={{ width: 26, height: 26, tintColor: palette.primary }}
      />
      <AppText className="font-semibold text-xl tracking-tight">Kiln</AppText>
    </View>
  )
}

/** Android has no native bar items; the same two buttons in React Native. */
function HeaderActions(): ReactElement {
  const navigation = useNavigation()
  return (
    <View className="flex-row items-center gap-5">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search"
        hitSlop={8}
        onPress={() => navigation.navigate("Search")}
      >
        <Icon name="magnifyingglass" size={20} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Account"
        hitSlop={8}
        onPress={() => navigation.navigate("Account")}
      >
        <Icon name="person.crop.circle" size={22} />
      </Pressable>
    </View>
  )
}

function ServerRouteScreen({
  route,
}: StaticScreenProps<RootStackParamList["Server"]>): ReactElement {
  if (route.params.page === "console") return <ConsoleScreen route={route} />
  if (route.params.page === "info") return <ServerScreen route={route} />
  const page = SERVER_PAGES.find((entry) => entry.id === route.params.page)
  return <NotYet eyebrow={route.params.name} title={page?.label ?? ""} />
}

const relayTitle = (params: unknown) =>
  (params as RootStackParamList["Relay"] | undefined)?.name ?? ""

const RootStack = createNativeStackNavigator({
  screenOptions: {
    headerShadowVisible: false,
    headerBackButtonDisplayMode: "minimal",
    headerTransparent: Platform.OS === "ios",
    headerTitleStyle: { fontFamily: "Geist-SemiBold" },
  },
  groups: {
    SignedOut: {
      if: useIsSignedOut,
      screens: {
        Connect: { screen: ConnectScreen, options: { headerShown: false } },
      },
    },
    SignedIn: {
      if: useIsSignedIn,
      screens: {
        Section: {
          screen: SectionScreen,
          initialParams: HOME,
          options: ({ navigation, route }): NativeStackNavigationOptions => ({
            // The page names itself in its heading; the title only labels
            // the back button's history menu.
            title: sectionLabel(route.params as RootStackParamList["Section"]),
            headerTitle: "",
            headerLeft: () => <Brand />,
            headerLeftBackgroundVisible: false,
            headerRight: () => <HeaderActions />,
            unstable_headerRightItems: () => [
              {
                type: "button",
                label: "Search",
                icon: { type: "sfSymbol", name: "magnifyingglass" },
                onPress: () => navigation.navigate("Search"),
              },
              {
                type: "button",
                label: "Account",
                icon: { type: "sfSymbol", name: "person.crop.circle" },
                onPress: () => navigation.navigate("Account"),
              },
            ],
            // Switching sections swaps the root page; cross-fade like a tab.
            animation: "fade",
          }),
        },
        Server: {
          screen: ServerRouteScreen,
          options: ({ route }) => ({ title: relayTitle(route.params) }),
        },
        Relay: {
          screen: RelayScreen,
          options: ({ route }) => ({ title: relayTitle(route.params) }),
        },
        Search: {
          screen: SearchScreen,
          options: {
            title: "Search",
            presentation: "formSheet",
            sheetAllowedDetents: [1],
            sheetGrabberVisible: true,
            headerTransparent: false,
          },
        },
        Account: {
          screen: AccountScreen,
          options: {
            title: "Account",
            presentation: "formSheet",
            sheetAllowedDetents: [0.75, 1],
            sheetGrabberVisible: true,
            headerTransparent: false,
          },
        },
      },
    },
  },
})

const Navigation = createStaticNavigation(RootStack)
const navigationRef = createNavigationContainerRef<RootStackParamList>()

const CONTENT_ROUTES = new Set(["Section", "Server", "Relay"])

/** The top page under any sheet, which the bar describes. */
function contentRoute(): ContentRoute | null {
  const routes = navigationRef.isReady() ? (navigationRef.getRootState()?.routes ?? []) : []
  const route = routes.findLast((entry) => CONTENT_ROUTES.has(entry.name))
  return (route as ContentRoute | undefined) ?? null
}

function Root() {
  const scheme = useColorScheme()
  const palette = usePalette()
  const { state } = useSessionContext()
  const ready = state.status !== "loading"
  const [content, setContent] = useState<ContentRoute | null>(null)
  const syncContent = () => setContent(contentRoute())

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync()
  }, [ready])

  const base = scheme === "light" ? DefaultTheme : DarkTheme
  const theme = {
    ...base,
    colors: {
      ...base.colors,
      primary: palette.foreground,
      background: palette.screen,
      card: palette.screen,
      text: palette.foreground,
      border: palette.border,
      notification: palette.primary,
    },
  }

  if (!ready) return null
  return (
    <>
      <StatusBar style={scheme === "light" ? "dark" : "light"} />
      <Navigation
        ref={navigationRef}
        theme={theme}
        onReady={syncContent}
        onStateChange={syncContent}
      />
      {content ? <NavBar navigation={navigationRef} route={content} /> : null}
    </>
  )
}

export function App() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <Root />
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  )
}
