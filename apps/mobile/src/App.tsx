import "../global.css"

import {
  DarkTheme,
  DefaultTheme,
  createStaticNavigation,
  useNavigation,
} from "@react-navigation/native"
import { createNativeStackNavigator } from "@react-navigation/native-stack"
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query"
import * as SplashScreen from "expo-splash-screen"
import { StatusBar } from "expo-status-bar"
import { useEffect, type ReactElement } from "react"
import { AppState, Platform, Pressable, useColorScheme } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"

import { Icon } from "./components/ui"
import { usePalette } from "./lib/palette"
import type { RootStackParamList } from "./navigation"
import { AccountScreen } from "./screens/AccountScreen"
import { ActivityScreen } from "./screens/ActivityScreen"
import { ConnectScreen } from "./screens/ConnectScreen"
import { ConsoleScreen } from "./screens/ConsoleScreen"
import { HomeScreen } from "./screens/HomeScreen"
import { RelayScreen } from "./screens/RelayScreen"
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

function AccountButton(): ReactElement {
  const navigation = useNavigation()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Account"
      hitSlop={8}
      onPress={() => navigation.navigate("Account")}
    >
      <Icon name="person.crop.circle" size={22} color="primaryText" />
    </Pressable>
  )
}

const titleOf = (params: unknown) =>
  (params as RootStackParamList["Relay"] | undefined)?.name ?? ""

const RootStack = createNativeStackNavigator({
  screenOptions: {
    headerLargeTitleShadowVisible: false,
    headerShadowVisible: false,
    headerBackButtonDisplayMode: "minimal",
    headerTransparent: Platform.OS === "ios",
    headerTitleStyle: { fontFamily: "Geist-SemiBold" },
    headerLargeTitleStyle: { fontFamily: "Geist-SemiBold" },
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
        Home: {
          screen: HomeScreen,
          options: {
            title: "Kiln",
            headerLargeTitle: true,
            headerRight: () => <AccountButton />,
          },
        },
        Server: {
          screen: ServerScreen,
          options: ({ route }) => ({ title: titleOf(route.params) }),
        },
        Console: {
          screen: ConsoleScreen,
          options: ({ route }) => ({ title: titleOf(route.params) }),
        },
        Relay: {
          screen: RelayScreen,
          options: ({ route }) => ({ title: titleOf(route.params) }),
        },
        Activity: {
          screen: ActivityScreen,
          options: { title: "Activity", headerLargeTitle: true },
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

function Root() {
  const scheme = useColorScheme()
  const palette = usePalette()
  const { state } = useSessionContext()
  const ready = state.status !== "loading"

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync()
  }, [ready])

  const base = scheme === "light" ? DefaultTheme : DarkTheme
  const theme = {
    ...base,
    colors: {
      ...base.colors,
      primary: palette.primaryText,
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
      <Navigation theme={theme} />
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
