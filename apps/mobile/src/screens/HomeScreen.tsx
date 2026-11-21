import { useNavigation } from "@react-navigation/native"
import type { SFSymbol } from "expo-symbols"
import type { ReactElement } from "react"
import { Pressable, View } from "react-native"

import { errorMessage } from "../api/hearth"
import {
  useRelayInfo,
  useRelays,
  useServers,
  type RelaySummary,
  type ServerSummary,
} from "../api/queries"
import {
  AppText,
  Card,
  Icon,
  KindIcon,
  KindTile,
  Loading,
  MonoText,
  Notice,
  Screen,
  SectionLabel,
  StatePill,
  stateTone,
  type InstanceKind,
} from "../components/ui"
import { cn } from "../lib/cn"
import { formatBytes, formatPercent } from "../lib/format"
import { useRecentPages, type RecentPage } from "../lib/recent-pages"
import {
  INFRA_PAGES,
  MANAGE_PAGES,
  SERVER_PAGES,
  sectionLabel,
  showSection,
  type RootStackParamList,
  type SectionParams,
} from "../navigation"

// Hearth's tree lines run through the centre of the Relay's tile.
const TILE = 36
const ROW_X = 16
const TRUNK_X = ROW_X + TILE / 2

/** A kind and how many there are, as Hearth's target counts show them. */
function KindCount(props: {
  readonly kind: InstanceKind
  readonly count: number | undefined
  readonly label: string
  readonly onPress: () => void
}) {
  const none = !props.count
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.count ?? 0} ${props.label}`}
      onPress={props.onPress}
      className="flex-row items-center gap-2 py-1 active:opacity-60"
    >
      <KindIcon kind={props.kind} size={24} />
      <MonoText className={cn("text-2xl", none && "text-foreground-muted")}>
        {props.count ?? 0}
      </MonoText>
    </Pressable>
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
        <MonoText className="text-2xs text-foreground-muted tracking-widest uppercase">
          {props.label}
        </MonoText>
        <MonoText className="text-2xs">{props.value}</MonoText>
      </View>
      <View className="bg-raised h-0.5">
        <View
          className={cn(
            "h-0.5",
            ratio > 0.9
              ? "bg-danger"
              : ratio > 0.75
                ? "bg-warning"
                : "bg-primary"
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
      className="active:bg-raised flex-row items-center gap-3 py-2 pr-4"
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
        <AppText className="text-sm font-medium" numberOfLines={1}>
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
        className="active:bg-raised flex-row items-center gap-3 py-3 pr-4"
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
          <AppText className="text-base font-semibold" numberOfLines={1}>
            {relay.name}
          </AppText>
          <MonoText
            className="text-2xs text-foreground-muted"
            numberOfLines={1}
          >
            {[
              version,
              relay.platform && relay.arch
                ? `${relay.platform}/${relay.arch}`
                : null,
            ]
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

const RECENT_TILES = {
  Relay: "relay",
  Server: "server",
} as const satisfies Partial<Record<RecentPage["name"], InstanceKind>>

/** What a remembered page is called, and where it sits. */
function describe(page: RecentPage): {
  readonly title: string
  readonly detail: string
  readonly symbol: SFSymbol | null
} {
  if (page.name === "Server") {
    const params = page.params as RootStackParamList["Server"]
    const sub = SERVER_PAGES.find((entry) => entry.id === params.page)
    return {
      title: params.name,
      detail: `Game server · ${sub?.label ?? ""}`,
      symbol: null,
    }
  }
  if (page.name === "Relay") {
    const params = page.params as RootStackParamList["Relay"]
    return { title: params.name, detail: "Relay", symbol: null }
  }
  const params = page.params as SectionParams
  const destination =
    params.area === "infra"
      ? INFRA_PAGES.find((entry) => entry.id === params.page)
      : params.area === "manage"
        ? MANAGE_PAGES.find((entry) => entry.id === params.page)
        : null
  return {
    title: sectionLabel(params),
    detail: params.area === "manage" ? "Manage" : "Infrastructure",
    symbol: destination?.symbol ?? null,
  }
}

function RecentPages() {
  const navigation = useNavigation()
  const recent = useRecentPages()

  const open = (page: RecentPage) => {
    if (page.name === "Section")
      showSection(navigation, page.params as SectionParams)
    else if (page.name === "Server")
      navigation.navigate("Server", page.params as RootStackParamList["Server"])
    else
      navigation.navigate("Relay", page.params as RootStackParamList["Relay"])
  }

  return (
    <>
      <SectionLabel>Recent</SectionLabel>
      {recent.length === 0 ? (
        <AppText className="text-foreground-muted px-1 text-sm">
          Pages you open show up here.
        </AppText>
      ) : (
        <Card>
          {recent.map((page, index) => {
            const { title, detail, symbol } = describe(page)
            const kind =
              page.name === "Section" ? null : RECENT_TILES[page.name]
            return (
              <Pressable
                key={page.key}
                accessibilityRole="button"
                accessibilityLabel={`${title}, ${detail}`}
                onPress={() => open(page)}
                className={cn(
                  "active:bg-raised flex-row items-center gap-3 px-4 py-2.5",
                  index < recent.length - 1 && "border-b border-border"
                )}
              >
                {kind ? (
                  <KindTile kind={kind} size={32} />
                ) : (
                  <View className="bg-screen size-8 items-center justify-center border border-border">
                    <Icon
                      name={symbol ?? "square.grid.2x2"}
                      size={15}
                      color="muted"
                    />
                  </View>
                )}
                <View className="min-w-0 flex-1">
                  <AppText className="text-sm font-medium" numberOfLines={1}>
                    {title}
                  </AppText>
                  <MonoText
                    className="text-2xs text-foreground-muted"
                    numberOfLines={1}
                  >
                    {detail}
                  </MonoText>
                </View>
                <Icon name="chevron.right" size={12} color="muted" />
              </Pressable>
            )
          })}
        </Card>
      )}
    </>
  )
}

/** Home: what's here at a glance, where you were, and the Relay tree. */
export function HomeScreen(): ReactElement {
  const navigation = useNavigation()
  const servers = useServers()
  const relays = useRelays()

  const attention =
    servers.data && relays.data
      ? servers.data.filter((server) => stateTone(server.state) === "danger")
          .length +
        relays.data.filter((relay) => stateTone(relay.status) === "danger")
          .length
      : 0

  return (
    <Screen
      onRefresh={() => Promise.all([servers.refetch(), relays.refetch()])}
    >
      {/* Every kind, as Hearth's target counts show them. The CLI API
          doesn't serve apps or databases yet; they read 0 until it does. */}
      <View className="flex-row items-center justify-center gap-8 pt-3 pb-1">
        <KindCount
          kind="relay"
          label="Relays"
          count={relays.data?.length}
          onPress={() =>
            showSection(navigation, { area: "infra", page: "relays" })
          }
        />
        <KindCount
          kind="server"
          label="game servers"
          count={servers.data?.length}
          onPress={() =>
            showSection(navigation, { area: "infra", page: "servers" })
          }
        />
        <KindCount
          kind="app"
          label="apps"
          count={0}
          onPress={() =>
            showSection(navigation, { area: "infra", page: "apps" })
          }
        />
        <KindCount
          kind="database"
          label="databases"
          count={0}
          onPress={() =>
            showSection(navigation, { area: "infra", page: "databases" })
          }
        />
      </View>
      {attention > 0 ? (
        <View className="flex-row items-center justify-center gap-1.5 pt-1">
          <View className="bg-danger size-2" />
          <MonoText className="text-danger text-xs">
            {attention} need a look
          </MonoText>
        </View>
      ) : null}

      <RecentPages />

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
            servers={
              servers.data?.filter((server) => server.relayId === relay.id) ??
              []
            }
          />
        ))
      )}
    </Screen>
  )
}
