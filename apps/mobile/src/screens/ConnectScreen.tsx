import type { ReactElement } from "react"
import { Effect, Fiber } from "effect"
import * as Haptics from "expo-haptics"
import * as Linking from "expo-linking"
import { useEffect, useRef, useState } from "react"
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  View,
} from "react-native"

import { errorMessage, normalizeHearthUrl } from "../api/hearth"
import { signInWithHearth } from "../api/sign-in"
import { AppText, Button, MonoText } from "../components/ui"
import { usePalette } from "../lib/palette"
import { useSessionContext } from "../session/SessionProvider"

const DEVICE_NAME = Platform.OS === "ios" ? "Kiln for iPhone" : "Kiln for Android"

export function ConnectScreen(): ReactElement {
  const { signIn } = useSessionContext()
  const palette = usePalette()
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef<Fiber.Fiber<unknown, unknown> | null>(null)

  useEffect(
    () => () => {
      if (running.current) Effect.runFork(Fiber.interrupt(running.current))
    },
    []
  )

  const begin = (address = url) => {
    const origin = normalizeHearthUrl(address)
    if (!origin) {
      setError("Enter your Hearth's address, such as hearth.example.com.")
      return
    }
    setError(null)
    setBusy(true)
    const program = signInWithHearth(origin, DEVICE_NAME).pipe(
      Effect.flatMap((session) =>
        session
          ? Effect.promise(() => {
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
              return signIn(session)
            })
          : Effect.void
      ),
      Effect.catch((failure) => Effect.sync(() => setError(errorMessage(failure)))),
      Effect.ensuring(Effect.sync(() => setBusy(false)))
    )
    running.current = Effect.runFork(program)
  }

  // `kiln://connect?url=<hearth>` fills in the address and starts signing in,
  // so a link or QR code from Hearth can hand the app its URL.
  const incoming = Linking.useLinkingURL()
  const handledLink = useRef<string | null>(null)
  useEffect(() => {
    if (!incoming || handledLink.current === incoming) return
    handledLink.current = incoming
    const { hostname, queryParams } = Linking.parse(incoming)
    const address = queryParams?.url
    if (hostname !== "connect" || typeof address !== "string") return
    setUrl(address)
    if (!busy) begin(address)
  }, [incoming])

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1 bg-screen"
    >
      <ScrollView
        contentContainerClassName="flex-grow justify-center px-6 py-16"
        keyboardShouldPersistTaps="handled"
      >
        <View className="mb-10 items-center gap-4">
          <Image
            source={require("../../assets/mark.png")}
            style={{ width: 64, height: 64, tintColor: palette.primary }}
            accessibilityIgnoresInvertColors
          />
          <AppText className="font-semibold text-3xl tracking-tight">
            Welcome to Kiln
          </AppText>
          <AppText className="text-center text-sm text-foreground-muted">
            Sign in to your control plane.
          </AppText>
        </View>

        <View className="gap-3">
          <MonoText className="px-1 text-2xs uppercase tracking-widest text-foreground-muted">
            Hearth address
          </MonoText>
          <TextInput
            value={url}
            onChangeText={setUrl}
            placeholder="hearth.example.com"
            placeholderTextColor={palette.muted}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="url"
            keyboardType="url"
            returnKeyType="go"
            textContentType="URL"
            onSubmitEditing={() => begin()}
            editable={!busy}
            className="min-h-12 border border-input bg-card px-4 font-mono text-base text-foreground"
          />
          {error ? (
            <AppText className="px-1 text-sm text-danger">{error}</AppText>
          ) : null}
          <Button
            label="Sign in"
            tone="primary"
            loading={busy}
            onPress={() => begin()}
          />
          <AppText className="px-1 pt-2 text-xs text-foreground-muted">
            You sign in on your Hearth's own page. This phone then shows with
            your linked CLIs in Hearth, where you can unlink it.
          </AppText>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
