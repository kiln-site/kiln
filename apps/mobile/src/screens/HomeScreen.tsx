import type { ReactElement } from "react"
import { useNavigation } from "@react-navigation/native"
import { Fragment } from "react"
import { View } from "react-native"

import { errorMessage } from "../api/hearth"
import { useRelays, useServers } from "../api/queries"
import {
  AppText,
  Card,
  Divider,
  Icon,
  Loading,
  MonoText,
  Notice,
  Row,
  Screen,
  SectionLabel,
  StatePill,
} from "../components/ui"

function Stat(props: { readonly label: string; readonly value: string; readonly detail: string }) {
  return (
    <View className="flex-1 gap-1 p-4">
      <AppText className="font-mono-medium text-2xs uppercase tracking-widest text-foreground-muted">
        {props.label}
      </AppText>
      <MonoText className="font-mono-medium text-2xl">{props.value}</MonoText>
      <AppText className="text-xs text-foreground-muted">{props.detail}</AppText>
    </View>
  )
}

export function HomeScreen(): ReactElement {
  const navigation = useNavigation()
  const servers = useServers()
  const relays = useRelays()

  const running = servers.data?.filter((server) => server.state === "running").length ?? 0
  const connected = relays.data?.filter((relay) => relay.status === "connected").length ?? 0
  const refreshing = servers.isRefetching || relays.isRefetching

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={() => {
        void servers.refetch()
        void relays.refetch()
      }}
    >
      <Card className="mt-2 flex-row">
        <Stat
          label="Running"
          value={servers.data ? `${running}/${servers.data.length}` : "—"}
          detail="game servers"
        />
        <View className="w-px bg-border" />
        <Stat
          label="Online"
          value={relays.data ? `${connected}/${relays.data.length}` : "—"}
          detail="Relays"
        />
      </Card>

      <SectionLabel>Game servers</SectionLabel>
      {servers.isPending ? (
        <Loading />
      ) : servers.isError ? (
        <Notice
          tone="danger"
          title="Couldn't load game servers"
          message={errorMessage(servers.error)}
          action={{ label: "Try again", onPress: () => void servers.refetch() }}
        />
      ) : servers.data.length === 0 ? (
        <Notice title="No game servers yet" message="Create one from Hearth or the Kiln CLI." />
      ) : (
        <Card>
          {servers.data.map((server, index) => (
            <Fragment key={server.id}>
              {index > 0 ? <Divider /> : null}
              <Row
                title={server.name}
                subtitle={`${server.relayName} · ${server.id}`}
                mono
                trailing={<StatePill state={server.state} />}
                onPress={() =>
                  navigation.navigate("Server", {
                    relayId: server.relayId,
                    instanceId: server.instanceId,
                    name: server.name,
                  })
                }
              />
            </Fragment>
          ))}
        </Card>
      )}

      <SectionLabel>Relays</SectionLabel>
      {relays.isPending ? (
        <Loading />
      ) : relays.isError ? (
        <Notice
          tone="danger"
          title="Couldn't load Relays"
          message={errorMessage(relays.error)}
        />
      ) : relays.data.length === 0 ? (
        <Notice title="No Relays paired" message="Pair a Relay from Hearth to run game servers." />
      ) : (
        <Card>
          {relays.data.map((relay, index) => (
            <Fragment key={relay.id}>
              {index > 0 ? <Divider /> : null}
              <Row
                title={relay.name}
                subtitle={[
                  relay.version
                    ? /^\d/u.test(relay.version)
                      ? `v${relay.version}`
                      : relay.version
                    : null,
                  relay.platform && relay.arch ? `${relay.platform}/${relay.arch}` : null,
                  relay.serverCount !== null
                    ? `${relay.serverCount} ${relay.serverCount === 1 ? "server" : "servers"}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                mono
                leading={<Icon name="server.rack" color="muted" />}
                trailing={<StatePill state={relay.status} />}
                onPress={() =>
                  navigation.navigate("Relay", { relayId: relay.id, name: relay.name })
                }
              />
            </Fragment>
          ))}
        </Card>
      )}

      <SectionLabel>Hearth</SectionLabel>
      <Card>
        <Row
          title="Activity"
          subtitle="Recent changes across your Hearth"
          leading={<Icon name="clock.arrow.circlepath" color="muted" />}
          onPress={() => navigation.navigate("Activity")}
        />
      </Card>
    </Screen>
  )
}
