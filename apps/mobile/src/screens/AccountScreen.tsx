import type { ReactElement } from "react"
import { useState } from "react"
import { ActivityIndicator, Alert, View } from "react-native"

import { useWhoami } from "../api/queries"
import { DrawerRow, DrawerSheet } from "../components/drawer"
import { AppText, MonoText } from "../components/ui"
import { formatRelative } from "../lib/format"
import { usePalette } from "../lib/palette"
import { useSession, useSessionContext } from "../session/SessionProvider"

function initials(name: string): string {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
}

function Detail(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-4 px-6 py-2">
      <AppText className="text-foreground-muted text-sm">{props.label}</AppText>
      <MonoText
        className="shrink text-right text-sm"
        numberOfLines={1}
        selectable
      >
        {props.value}
      </MonoText>
    </View>
  )
}

/** The account sheet: who's signed in, this device's link, and sign out. */
export function AccountScreen(): ReactElement {
  const session = useSession()
  const { signOut } = useSessionContext()
  const whoami = useWhoami()
  const palette = usePalette()
  const [signingOut, setSigningOut] = useState(false)
  const name = whoami.data?.user.name ?? ""
  const { credential } = session

  const confirmSignOut = () =>
    Alert.alert(
      "Sign out?",
      "This revokes this device's access to your Hearth.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            setSigningOut(true)
            void signOut()
          },
        },
      ]
    )

  return (
    <DrawerSheet title="Account">
      <View className="flex-row items-center gap-3 px-6 py-2.5">
        {/* Hearth's avatar without a picture: initials on the accent. */}
        <View
          className="size-11 items-center justify-center"
          style={{ backgroundColor: `${palette.primary}26` }}
        >
          <AppText className="text-primary-text text-base font-semibold">
            {initials(name)}
          </AppText>
        </View>
        <View className="min-w-0 flex-1">
          <AppText className="text-base font-semibold" numberOfLines={1}>
            {name || "…"}
          </AppText>
          <AppText className="text-foreground-muted text-sm" numberOfLines={1}>
            {whoami.data?.user.email ?? " "}
          </AppText>
        </View>
      </View>

      <View className="my-2 border-y border-border py-1">
        <Detail label="Hearth" value={new URL(session.url).host} />
        <Detail
          label="Access"
          value={credential.mode === "read_only" ? "read-only" : "full access"}
        />
        <Detail
          label="Expires"
          value={
            credential.expiresAt
              ? formatRelative(credential.expiresAt)
              : "never"
          }
        />
        <Detail label="Device" value={credential.name} />
      </View>

      <DrawerRow
        symbol="rectangle.portrait.and.arrow.right"
        label="Sign out"
        tone="danger"
        onPress={confirmSignOut}
        trailing={
          signingOut ? <ActivityIndicator color={palette.danger} /> : null
        }
      />
    </DrawerSheet>
  )
}
