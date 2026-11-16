import { useNavigation } from "@react-navigation/native"
import type { ReactElement } from "react"
import { Pressable, View } from "react-native"

import { errorMessage } from "../api/hearth"
import {
  useActivity,
  useRelayInfo,
  useRelays,
  useServers,
  type RelaySummary,
  type ServerSummary,
} from "../api/queries"
import { ActivityRow } from "../components/ActivityRow"
import {
  AppText,
  Card,
  KindTile,
  Loading,
  MonoText,
  Notice,
  PageHeading,
  Screen,
  SectionLabel,
  StatePill,
  stateTone,
} from "../components/ui"
import { cn } from "../lib/cn"
import { formatBytes, formatPercent } from "../lib/format"
import { showSection } from "../navigation"

// Hearth's tree lines run through the centre of the Relay's tile.
const TILE = 36
const ROW_X = 16
const TRUNK_X = ROW_X + TILE / 2

function Summary(props: {
  readonly label: string
  readonly value: number | null
  readonly total?: number | null
  readonly detail: string
  readonly alert?: boolean
}) {
  return (
    <View className="flex-1 gap-1.5 px-3.5 py-3">
      <MonoText className="text-2xs uppercase tracking-widest text-foreground-muted">
        {props.label}
      </MonoText>
      <View className="flex-row items-baseline">
        <MonoText
          className={cn("font-mono-medium text-2xl", props.alert && "text-danger")}
        >
          {props.value ?? "–"}
        </MonoText>
        {props.total != null ? (
          <MonoText className="text-sm text-foreground-muted">/{props.total}</MonoText>
        ) : null}
      </View>
      <AppText className="text-xs text-foreground-muted">{props.detail}</AppText>
    </View>
  )
}

function NodeStat(props: {
  readonly label: string
  readonly value: string
  readonly ratio: number
}) {
  const ratio = Math.min(Math.max(props.ratio, 0), 1)
  return (
    <View className="flex-1 gap-1.5 px-3.5 py-2.5">
      <View className="flex-row items-baseline justify-between">
        <MonoText className="text-2xs uppercase tracking-widest text-foreground-muted">
          {props.label}
        </MonoText>
        <MonoText className="text-2xs">{props.value}</MonoText>
      </View>
      <View className="h-0.5 bg-raised">
        <View
          className={cn(
            "h-0.5",
            ratio > 0.9 ? "bg-danger" : ratio > 0.75 ? "bg-warning" : "bg-primary"
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </View>
    </View>
  )
}

function ServerBranch(props: {
  readonly server: ServerSummary
  readonly last: boolean
}) {
  const navigation = useNavigation()
  const { server } = props
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${server.name}, game server, ${server.state}`}
      onPress={() =>
        navigation.navigate("Server", {
          relayId: server.relayId,
          instanceId: server.instanceId,
          name: server.name,
          page: "console",
        })
      }
      className="flex-row items-center gap-3 py-2 pr-4 active:bg-raised"
      style={{ paddingLeft: TRUNK_X + 18 }}
    >
      {/* The trunk down from the Relay, and this branch's elbow. */}
      <View
        className="absolute w-px bg-border"
        style={{ left: TRUNK_X, top: 0, bottom: props.last ? "50%" : 0 }}
      />
      <View
        className="absolute h-px bg-border"
        style={{ left: TRUNK_X, width: 12, top: "50%" }}
      />
      <KindTile kind="server" state={server.state} size={30} />
      <View className="min-w-0 flex-1">
        <AppText className="font-medium text-sm" numberOfLines={1}>
          {server.name}
        </AppText>
        <MonoText className="text-2xs text-foreground-muted" numberOfLines={1}>
          {server.id}
        </MonoText>
      </View>
      <StatePill state={server.state} />
    </Pressable>
  )
}

function RelayNode(props: {
  readonly relay: RelaySummary
  readonly servers: readonly ServerSummary[]
}) {
  const navigation = useNavigation()
  const { relay, servers } = props
  const connected = relay.status === "connected"
  const info = useRelayInfo(relay.id, { enabled: connected })
  const node = connected ? info.data?.node : null
  const version = relay.version
    ? /^\d/u.test(relay.version)
      ? `v${relay.version}`
      : relay.version
    : null

  return (
    <Card className="mb-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${relay.name}, Relay, ${relay.status}`}
        onPress={() =>
          navigation.navigate("Relay", { relayId: relay.id, name: relay.name })
        }
        className="flex-row items-center gap-3 py-3 pr-4 active:bg-raised"
        style={{ paddingLeft: ROW_X }}
      >
        {servers.length > 0 ? (
          <View
            className="absolute w-px bg-border"
            style={{ left: TRUNK_X, height: 12, bottom: 0 }}
          />
        ) : null}
        <KindTile kind="relay" state={relay.status} size={TILE} />
        <View className="min-w-0 flex-1">
          <AppText className="font-semibold text-base" numberOfLines={1}>
            {relay.name}
          </AppText>
          <MonoText className="text-2xs text-foreground-muted" numberOfLines={1}>
            {[version, relay.platform && relay.arch ? `${relay.platform}/${relay.arch}` : null]
              .filter(Boolean)
              .join(" · ") || relay.id}
          </MonoText>
        </View>
        <StatePill state={relay.status} />
      </Pressable>

      {servers.map((server, index) => (
        <ServerBranch
          key={server.id}
          server={server}
          last={index === servers.length - 1}
        />
      ))}
      {servers.length > 0 ? <View className="h-2" /> : null}

      {node ? (
        <View className="flex-row border-t border-border">
          <NodeStat
            label="CPU"
            value={formatPercent(node.cpuLoadPercent)}
            ratio={node.cpuLoadPercent / 100}
          />
          <View className="w-px bg-border" />
          <NodeStat
            label="Mem"
            value={formatBytes(node.memory.usedBytes)}
            ratio={node.memory.usedBytes / (node.memory.totalBytes || 1)}
          />
          <View className="w-px bg-border" />
          <NodeStat
            label="Disk"
            value={formatBytes(node.storage.usedBytes)}
            ratio={node.storage.usedBytes / (node.storage.totalBytes || 1)}
          />
        </View>
      ) : null}
    </Card>
  )
}

function RecentActivity() {
  const navigation = useNavigation()
  const activity = useActivity()
  const recent = activity.data?.slice(0, 4) ?? []

  return (
    <>
      <SectionLabel
        trailing={
          <Pressable
            accessibilityRole="button"
            hitSlop={10}
            onPress={() => showSection(navigation, { area: "manage", page: "activity" })}
          >
            <MonoText className="text-2xs uppercase tracking-widest text-primary-text">
              All activity
            </MonoText>
          </Pressable>
        }
      >
        Recent activity
      </SectionLabel>
      {activity.isPending ? (
        <Loading />
      ) : activity.isError ? (
        <Notice tone="danger" title="Couldn't load activity" message={errorMessage(activity.error)} />
      ) : recent.length === 0 ? (
        <Notice title="Nothing has happened yet" />
      ) : (
        <Card>
          {recent.map((entry, index) => (
            <ActivityRow
              key={entry.id}
              entry={entry}
              divider={index < recent.length - 1}
            />
          ))}
        </Card>
      )}
    </>
  )
}

/** Infra › Overview: Hearth's map, as a tree of Relays and what they run. */
export function OverviewScreen(): ReactElement {
  const servers = useServers()
  const relays = useRelays()

  const running = servers.data?.filter((server) => server.state === "running").length
  const online = relays.data?.filter((relay) => relay.status === "connected").length
  const attention =
    servers.data && relays.data
      ? servers.data.filter((server) => stateTone(server.state) === "danger").length +
        relays.data.filter((relay) => stateTone(relay.status) === "danger").length
      : null

  return (
    <Screen
      refreshing={servers.isRefetching || relays.isRefetching}
      onRefresh={() => {
        void servers.refetch()
        void relays.refetch()
      }}
    >
      <PageHeading eyebrow="Infrastructure" title="Overview" />

      <Card className="flex-row">
        <Summary
          label="Game servers"
          value={running ?? null}
          total={servers.data?.length}
          detail="running"
        />
        <View className="w-px bg-border" />
        <Summary
          label="Relays"
          value={online ?? null}
          total={relays.data?.length}
          detail="online"
        />
        <View className="w-px bg-border" />
        <Summary
          label="Attention"
          value={attention}
          detail={attention ? "need a look" : "all clear"}
          alert={Boolean(attention)}
        />
      </Card>

      <SectionLabel>Relays</SectionLabel>
      {relays.isPending ? (
        <Loading />
      ) : relays.isError ? (
        <Notice
          tone="danger"
          title="Couldn't load Relays"
          message={errorMessage(relays.error)}
          action={{ label: "Try again", onPress: () => void relays.refetch() }}
        />
      ) : relays.data.length === 0 ? (
        <Notice
          title="No Relays paired"
          message="Pair a Relay from Hearth to run game servers."
        />
      ) : (
        relays.data.map((relay) => (
          <RelayNode
            key={relay.id}
            relay={relay}
            servers={servers.data?.filter((server) => server.relayId === relay.id) ?? []}
          />
        ))
      )}

      <RecentActivity />
    </Screen>
  )
}
