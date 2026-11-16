import type { ReactElement } from "react"
import { Effect, Fiber } from "effect"
import * as Haptics from "expo-haptics"
import * as Linking from "expo-linking"
import * as WebBrowser from "expo-web-browser"
import { useEffect, useRef, useState } from "react"
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  View,
} from "react-native"

import {
  awaitDeviceToken,
  startDeviceLogin,
  type DeviceCode,
} from "../api/device-login"
import { errorMessage, normalizeHearthUrl } from "../api/hearth"
import { AppText, Button, Card, Icon, MonoText } from "../components/ui"
import { usePalette } from "../lib/palette"
import { useSessionContext } from "../session/SessionProvider"

const DEVICE_NAME = Platform.OS === "ios" ? "Kiln for iPhone" : "Kiln for Android"

type Step =
  | { readonly kind: "url" }
  | { readonly kind: "starting" }
  | { readonly kind: "approve"; readonly origin: string; readonly code: DeviceCode }

/**
 * Hearth builds its approval link from its own configured URL, which may be
 * a name the phone can't resolve. Open the same page on the origin the
 * person typed, which the phone just reached.
 */
function approvalUrl(origin: string, code: DeviceCode): string {
  const link = new URL(code.verificationUriComplete)
  return `${origin}${link.pathname}${link.search}`
}

export function ConnectScreen(): ReactElement {
  const { signIn } = useSessionContext()
  const palette = usePalette()
  const [url, setUrl] = useState("")
  const [step, setStep] = useState<Step>({ kind: "url" })
  const [error, setError] = useState<string | null>(null)
  const polling = useRef<Fiber.Fiber<unknown, unknown> | null>(null)

  useEffect(
    () => () => {
      if (polling.current) Effect.runFork(Fiber.interrupt(polling.current))
    },
    []
  )

  const openApproval = (origin: string, code: DeviceCode) => {
    // An auth session shares Safari's cookies, so a Hearth already signed in
    // there approves in one tap. It closes itself once the token arrives.
    void WebBrowser.openAuthSessionAsync(approvalUrl(origin, code), "kiln://")
  }

  const begin = (address = url) => {
    const origin = normalizeHearthUrl(address)
    if (!origin) {
      setError("Enter your Hearth's address, such as hearth.example.com.")
      return
    }
    setError(null)
    setStep({ kind: "starting" })
    const program = Effect.gen(function* () {
      const code = yield* startDeviceLogin(origin, DEVICE_NAME)
      setStep({ kind: "approve", origin, code })
      openApproval(origin, code)
      const session = yield* awaitDeviceToken(origin, code)
      WebBrowser.dismissAuthSession()
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      yield* Effect.promise(() => signIn(session))
    }).pipe(
      Effect.catch((failure) =>
        Effect.sync(() => {
          WebBrowser.dismissAuthSession()
          setError(errorMessage(failure))
          setStep({ kind: "url" })
        })
      )
    )
    polling.current = Effect.runFork(program)
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
    if (step.kind === "url") begin(address)
  }, [incoming])

  const cancel = () => {
    if (polling.current) Effect.runFork(Fiber.interrupt(polling.current))
    polling.current = null
    setStep({ kind: "url" })
  }

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
            style={{ width: 72, height: 72 }}
            accessibilityIgnoresInvertColors
          />
          <AppText className="font-semibold text-2xl">Kiln</AppText>
          <AppText className="text-center text-sm text-foreground-muted">
            Your game servers, Relays and activity, from your pocket.
          </AppText>
        </View>

        {step.kind === "approve" ? (
          <Card className="gap-4 p-5">
            <View className="flex-row items-center gap-2">
              <Icon name="checkmark.shield" color="primary" />
              <AppText className="font-semibold text-base">
                Approve this device
              </AppText>
            </View>
            <AppText className="text-sm text-foreground-muted">
              Sign in to Hearth in the browser and approve the request. Check
              that it shows this code:
            </AppText>
            <MonoText
              className="font-mono-medium py-2 text-center text-2xl tracking-[6px] text-primary-text"
              selectable
            >
              {step.code.userCode}
            </MonoText>
            <Button
              label="Open approval page"
              tone="primary"
              icon="safari"
              onPress={() => openApproval(step.origin, step.code)}
            />
            <Button label="Cancel" onPress={cancel} />
            <MonoText className="text-center text-2xs text-foreground-muted">
              Waiting for approval on {new URL(step.origin).host}
            </MonoText>
          </Card>
        ) : (
          <View className="gap-3">
            <AppText className="font-mono-medium px-1 text-2xs uppercase tracking-widest text-foreground-muted">
              Hearth address
            </AppText>
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
              editable={step.kind === "url"}
              className="min-h-12 border border-input bg-card px-4 font-mono text-base text-foreground"
            />
            {error ? (
              <AppText className="px-1 text-sm text-danger">{error}</AppText>
            ) : null}
            <Button
              label="Continue"
              tone="primary"
              loading={step.kind === "starting"}
              onPress={() => begin()}
            />
            <AppText className="px-1 pt-2 text-xs text-foreground-muted">
              Kiln signs in the way the Kiln CLI does: you approve this device
              from Hearth, and can revoke it there any time.
            </AppText>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
