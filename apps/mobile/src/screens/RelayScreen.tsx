import type { ReactElement } from "react"
import { useNavigation, type StaticScreenProps } from "@react-navigation/native"
import { Fragment } from "react"
import { View } from "react-native"

import { errorMessage } from "../api/hearth"
import { useRelayInfo, useServers } from "../api/queries"
import {
  AppText,
  Card,
  Divider,
  Loading,
  Meter,
  MonoText,
  Notice,
  Row,
  Screen,
  SectionLabel,
  StatePill,
} from "../components/ui"
import { formatBytes, formatDuration, formatPercent } from "../lib/format"

type Props = StaticScreenProps<{ relayId: string; name: string }>

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

export function RelayScreen({ route }: Props): ReactElement {
  const { relayId } = route.params
  const navigation = useNavigation()
  const info = useRelayInfo(relayId)
  const servers = useServers()
  const hosted = servers.data?.filter((server) => server.relayId === relayId) ?? []

  if (info.isPending)
    return (
      <Screen>
        <Loading />
      </Screen>
    )
  if (info.isError)
    return (
      <Screen>
        <View className="mt-4">
          <Notice
            tone="danger"
            title="Couldn't load this Relay"
            message={errorMessage(info.error)}
            action={{ label: "Try again", onPress: () => void info.refetch() }}
          />
        </View>
      </Screen>
    )

  const { relay, node } = info.data

  return (
    <Screen refreshing={info.isRefetching} onRefresh={() => void info.refetch()}>
      <Card className="mt-2 flex-row items-center justify-between p-4">
        <StatePill state={relay.status} />
        <MonoText className="text-xs text-foreground-muted">
          {node ? `up ${formatDuration(node.uptimeSeconds)}` : "no node data"}
        </MonoText>
      </Card>

      {node ? (
        <>
          <SectionLabel>Node</SectionLabel>
          <Card>
            <View className="flex-row">
              <Meter
                label="CPU"
                value={formatPercent(node.cpuLoadPercent)}
                detail={`${node.cpuCores} cores`}
                ratio={node.cpuLoadPercent / 100}
              />
              <View className="w-px bg-border" />
              <Meter
                label="Memory"
                value={formatBytes(node.memory.usedBytes)}
                detail={`of ${formatBytes(node.memory.totalBytes)}`}
                ratio={node.memory.usedBytes / node.memory.totalBytes}
              />
            </View>
            <View className="h-px bg-border" />
            <View className="flex-row">
              <Meter
                label="Storage"
                value={formatBytes(node.storage.usedBytes)}
                detail={`of ${formatBytes(node.storage.totalBytes)}`}
                ratio={node.storage.usedBytes / node.storage.totalBytes}
              />
            </View>
          </Card>
        </>
      ) : null}

      <SectionLabel>Game servers</SectionLabel>
      {hosted.length === 0 ? (
        <Notice title="No game servers on this Relay" />
      ) : (
        <Card>
          {hosted.map((server, index) => (
            <Fragment key={server.id}>
              {index > 0 ? <Divider /> : null}
              <Row
                title={server.name}
                subtitle={server.id}
                mono
                trailing={<StatePill state={server.state} />}
                onPress={() =>
                  navigation.navigate("Server", {
                    relayId: server.relayId,
                    instanceId: server.instanceId,
                    name: server.name,
                    page: "console",
                  })
                }
              />
            </Fragment>
          ))}
        </Card>
      )}

      <SectionLabel>Details</SectionLabel>
      <Card>
        <Detail label="Version" value={relay.version ?? "—"} />
        <Divider />
        <Detail
          label="Platform"
          value={relay.platform && relay.arch ? `${relay.platform}/${relay.arch}` : "—"}
        />
        <Divider />
        <Detail label="ID" value={relay.id} />
      </Card>
    </Screen>
  )
}
