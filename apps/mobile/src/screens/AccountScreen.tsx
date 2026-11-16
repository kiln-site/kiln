import type { ReactElement } from "react"
import { useState } from "react"
import { Alert, View } from "react-native"

import { useWhoami } from "../api/queries"
import { AppText, Button, Card, Divider, MonoText, Screen, SectionLabel } from "../components/ui"
import { formatRelative } from "../lib/format"
import { useSession, useSessionContext } from "../session/SessionProvider"

function Detail(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-4 px-4 py-3">
      <AppText className="text-sm text-foreground-muted">{props.label}</AppText>
      <MonoText className="shrink text-right text-sm" numberOfLines={1} selectable>
        {props.value}
      </MonoText>
    </View>
  )
}

export function AccountScreen(): ReactElement {
  const session = useSession()
  const { signOut } = useSessionContext()
  const whoami = useWhoami()
  const [signingOut, setSigningOut] = useState(false)

  const confirmSignOut = () =>
    Alert.alert("Sign out?", "This revokes this device's access to your Hearth.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          setSigningOut(true)
          void signOut()
        },
      },
    ])

  const { credential } = session
  return (
    <Screen>
      <SectionLabel>Signed in as</SectionLabel>
      <Card className="gap-1 p-4">
        <AppText className="font-semibold text-lg">
          {whoami.data?.user.name ?? "…"}
        </AppText>
        <AppText className="text-sm text-foreground-muted">
          {whoami.data?.user.email ?? " "}
        </AppText>
      </Card>

      <SectionLabel>This device</SectionLabel>
      <Card>
        <Detail label="Hearth" value={new URL(session.url).host} />
        <Divider />
        <Detail
          label="Access"
          value={credential.mode === "read_only" ? "read-only" : "full access"}
        />
        <Divider />
        <Detail
          label="Expires"
          value={credential.expiresAt ? formatRelative(credential.expiresAt) : "never"}
        />
        <Divider />
        <Detail label="Name" value={credential.name} />
      </Card>

      <Button
        className="mt-8"
        label="Sign out"
        tone="danger"
        icon="rectangle.portrait.and.arrow.right"
        loading={signingOut}
        onPress={confirmSignOut}
      />
    </Screen>
  )
}
