import { useNavigation, type StaticScreenProps } from "@react-navigation/native"
import type { ReactElement } from "react"
import { Pressable, View } from "react-native"

import { errorMessage } from "../api/hearth"
import { useRelays, useServers } from "../api/queries"
import {
  AppText,
  Card,
  KindTile,
  Loading,
  MonoText,
  Notice,
  Screen,
  StatePill,
  type InstanceKind,
} from "../components/ui"
import { cn } from "../lib/cn"
import { pageTitle, sectionLabel, type SectionParams } from "../navigation"
import { ActivityScreen } from "./ActivityScreen"
import { HomeScreen } from "./HomeScreen"

type Props = StaticScreenProps<SectionParams>

function InstanceRow(props: {
  readonly kind: InstanceKind
  readonly name: string
  readonly detail: string
  readonly state: string
  readonly divider: boolean
  readonly onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.name}, ${props.state}`}
      onPress={props.onPress}
      className={cn(
        "active:bg-raised flex-row items-center gap-3 px-4 py-3",
        props.divider && "border-b border-border"
      )}
    >
      <KindTile kind={props.kind} state={props.state} />
      <View className="min-w-0 flex-1">
        <AppText className="text-base font-medium" numberOfLines={1}>
          {props.name}
        </AppText>
        <MonoText className="text-2xs text-foreground-muted" numberOfLines={1}>
          {props.detail}
        </MonoText>
      </View>
      <StatePill state={props.state} />
    </Pressable>
  )
}

function ServersPage(): ReactElement {
  const navigation = useNavigation()
  const servers = useServers()
  return (
    <Screen onRefresh={() => servers.refetch()}>
      {servers.isPending ? (
        <Loading />
      ) : servers.isError ? (
        <Notice
          tone="danger"
          title="Couldn't load game servers"
          message={errorMessage(servers.error)}
        />
      ) : servers.data.length === 0 ? (
        <Notice
          title="No game servers yet"
          message="Create one from Hearth or the Kiln CLI."
        />
      ) : (
        <Card>
          {servers.data.map((server, index) => (
            <InstanceRow
              key={server.id}
              kind="server"
              name={server.name}
              detail={`${server.relayName} · ${server.id}`}
              state={server.state}
              divider={index < servers.data.length - 1}
              onPress={() =>
                navigation.navigate("Server", {
                  relayId: server.relayId,
                  instanceId: server.instanceId,
                  name: server.name,
                  page: "console",
                })
              }
            />
          ))}
        </Card>
      )}
    </Screen>
  )
}

function RelaysPage(): ReactElement {
  const navigation = useNavigation()
  const relays = useRelays()
  return (
    <Screen onRefresh={() => relays.refetch()}>
      {relays.isPending ? (
        <Loading />
      ) : relays.isError ? (
        <Notice
          tone="danger"
          title="Couldn't load Relays"
          message={errorMessage(relays.error)}
        />
      ) : relays.data.length === 0 ? (
        <Notice
          title="No Relays paired"
          message="Pair a Relay from Hearth to run game servers."
        />
      ) : (
        <Card>
          {relays.data.map((relay, index) => (
            <InstanceRow
              key={relay.id}
              kind="relay"
              name={relay.name}
              detail={[
                relay.serverCount === null
                  ? null
                  : `${relay.serverCount} game ${relay.serverCount === 1 ? "server" : "servers"}`,
                relay.id,
              ]
                .filter(Boolean)
                .join(" · ")}
              state={relay.status}
              divider={index < relays.data.length - 1}
              onPress={() =>
                navigation.navigate("Relay", {
                  relayId: relay.id,
                  name: relay.name,
                })
              }
            />
          ))}
        </Card>
      )}
    </Screen>
  )
}

/** A page Hearth has that the CLI API can't serve the app yet. */
export function NotYet(props: { readonly title: string }): ReactElement {
  return (
    <Screen>
      <Card className="mt-2 gap-1 p-4">
        <AppText className="text-sm font-semibold">Not on mobile yet</AppText>
        <AppText className="text-foreground-muted text-sm">
          Open {props.title} in Hearth for now. It comes to the app once the CLI
          API serves it.
        </AppText>
      </Card>
    </Screen>
  )
}

export function SectionScreen({ route }: Props): ReactElement {
  const params = route.params
  if (params.area === "home") return <HomeScreen />
  if (params.area === "infra") {
    if (params.page === "servers") return <ServersPage />
    if (params.page === "relays") return <RelaysPage />
    return <NotYet title={sectionLabel(params)} />
  }
  if (params.page === "activity") return <ActivityScreen />
  return <NotYet title={pageTitle(params)} />
}
