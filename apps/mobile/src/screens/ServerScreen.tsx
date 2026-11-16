import type { ReactElement } from "react"
import { useNavigation, type StaticScreenProps } from "@react-navigation/native"
import * as Clipboard from "expo-clipboard"
import * as Haptics from "expo-haptics"
import { Alert, Pressable, View } from "react-native"

import { errorMessage } from "../api/hearth"
import { usePowerAction, useServerInfo, type PowerAction } from "../api/queries"
import {
  AppText,
  Button,
  Card,
  Divider,
  Icon,
  Loading,
  Meter,
  MonoText,
  Notice,
  Row,
  Screen,
  SectionLabel,
  StatePill,
} from "../components/ui"
import { formatBytes, formatPercent, formatRelative } from "../lib/format"
import { useSession } from "../session/SessionProvider"

type Props = StaticScreenProps<{
  relayId: string
  instanceId: string
  name: string
}>

const TRANSITIONAL = new Set(["starting", "stopping", "provisioning"])

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

export function ServerScreen({ route }: Props): ReactElement {
  const { relayId, instanceId } = route.params
  const navigation = useNavigation()
  const session = useSession()
  const info = useServerInfo({ relayId, instanceId })
  const power = usePowerAction({ relayId, instanceId })
  const readOnly = session.credential.mode === "read_only"

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
            title="Couldn't load this server"
            message={errorMessage(info.error)}
            action={{ label: "Try again", onPress: () => void info.refetch() }}
          />
        </View>
      </Screen>
    )

  const { server, relay } = info.data
  const state = server.observedState
  const busy = power.isPending || TRANSITIONAL.has(state)
  const isRunning = state === "running" || state === "starting"
  // The last sample outlives the process; a stopped server uses nothing.
  const resources = state === "running" ? server.resources : null

  const act = (action: PowerAction) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    power.mutate(action, {
      onError: (error) => Alert.alert("Couldn't do that", errorMessage(error)),
    })
  }
  const confirm = (action: PowerAction, title: string, message: string) =>
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: title, style: "destructive", onPress: () => act(action) },
    ])

  const address = server.publicAddress ?? server.connectAddress
  const copyAddress = () => {
    void Clipboard.setStringAsync(address)
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
  }

  return (
    <Screen refreshing={info.isRefetching} onRefresh={() => void info.refetch()}>
      <Card className="mt-2 gap-4 p-4">
        <View className="flex-row items-center justify-between">
          <StatePill state={state} />
          <MonoText className="text-xs text-foreground-muted">
            wants {server.desiredState}
          </MonoText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Copy address ${address}`}
          onPress={copyAddress}
          className="flex-row items-center justify-between gap-3 border border-border bg-surface-low px-3 py-3 active:bg-raised"
        >
          <MonoText className="font-mono-medium shrink text-base" numberOfLines={1}>
            {address}
          </MonoText>
          <Icon name="doc.on.doc" size={15} color="muted" />
        </Pressable>
        {readOnly ? (
          <AppText className="text-xs text-foreground-muted">
            This device has read-only access. Approve a full-access sign-in to
            control power.
          </AppText>
        ) : (
          <View className="gap-2">
            <View className="flex-row gap-2">
              {isRunning ? (
                <Button
                  className="flex-1"
                  label="Stop"
                  icon="stop.fill"
                  disabled={busy}
                  onPress={() => act("stop")}
                />
              ) : (
                <Button
                  className="flex-1"
                  label="Start"
                  icon="play.fill"
                  tone="primary"
                  disabled={busy}
                  loading={power.isPending && power.variables === "start"}
                  onPress={() => act("start")}
                />
              )}
              <Button
                className="flex-1"
                label="Restart"
                icon="arrow.clockwise"
                disabled={busy || !isRunning}
                loading={power.isPending && power.variables === "restart"}
                onPress={() => act("restart")}
              />
            </View>
            {state !== "stopped" ? (
              <Button
                label="Kill"
                icon="bolt.fill"
                tone="danger"
                disabled={power.isPending}
                onPress={() =>
                  confirm(
                    "kill",
                    "Kill",
                    "Kill stops the process at once, without saving. Use it only when Stop doesn't work."
                  )
                }
              />
            ) : null}
          </View>
        )}
      </Card>

      <SectionLabel
        trailing={
          resources ? (
            <MonoText className="text-2xs text-foreground-muted">
              {formatRelative(resources.sampledAt)}
            </MonoText>
          ) : null
        }
      >
        Resources
      </SectionLabel>
      <Card>
        <View className="flex-row">
          <Meter
            label="CPU"
            value={formatPercent(resources?.cpuPercent)}
            ratio={resources ? resources.cpuPercent / 100 : null}
            detail="100% is one core"
            neutral
          />
          <View className="w-px bg-border" />
          <Meter
            label="Memory"
            value={formatBytes(resources?.memoryUsedBytes)}
            detail={server.memoryLimitBytes ? `of ${formatBytes(server.memoryLimitBytes)}` : "no limit"}
            ratio={
              resources && server.memoryLimitBytes
                ? resources.memoryUsedBytes / server.memoryLimitBytes
                : null
            }
          />
        </View>
        <View className="h-px bg-border" />
        <View className="flex-row">
          <Meter
            label="Disk"
            value={formatBytes(resources?.storageUsedBytes)}
            detail={server.diskLimitBytes ? `of ${formatBytes(server.diskLimitBytes)}` : "no limit"}
            ratio={
              resources?.storageUsedBytes != null && server.diskLimitBytes
                ? resources.storageUsedBytes / server.diskLimitBytes
                : null
            }
          />
          <View className="w-px bg-border" />
          <Meter
            label="Network"
            value={`↓ ${formatBytes(resources?.networkReceivedBytes)}`}
            detail={`↑ ${formatBytes(resources?.networkSentBytes)}`}
            ratio={null}
          />
        </View>
      </Card>

      <SectionLabel>Manage</SectionLabel>
      <Card>
        <Row
          title="Console"
          subtitle="Live output and commands"
          leading={<Icon name="terminal" color="muted" />}
          onPress={() => navigation.setParams({ page: "console" })}
        />
        <Divider />
        <Row
          title={relay.name}
          subtitle="Relay"
          leading={<Icon name="server.rack" color="muted" />}
          onPress={() => navigation.navigate("Relay", { relayId: relay.id, name: relay.name })}
        />
      </Card>

      <SectionLabel>Details</SectionLabel>
      <Card>
        <Detail label="Game" value={server.game} />
        <Divider />
        <Detail label="Software" value={`${server.implementation} ${server.version}`} />
        {server.javaVersion ? (
          <>
            <Divider />
            <Detail label="Java" value={server.javaVersion} />
          </>
        ) : null}
        {server.brickId ? (
          <>
            <Divider />
            <Detail label="Brick" value={server.brickId} />
          </>
        ) : null}
        <Divider />
        <Detail label="ID" value={server.id} />
      </Card>
    </Screen>
  )
}
