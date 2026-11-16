import type { ReactElement } from "react"
import { useNavigation, type StaticScreenProps } from "@react-navigation/native"
import * as Haptics from "expo-haptics"
import { memo, useEffect, useRef, useState } from "react"
import {
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native"

import { useConsole, useSendCommand, type ConsoleLine } from "../api/console"
import { errorMessage } from "../api/hearth"
import { AppText, Icon, MonoText } from "../components/ui"
import { useBarInset } from "../components/chrome"
import { cn } from "../lib/cn"
import { formatClock } from "../lib/format"
import { usePalette } from "../lib/palette"
import { useSession } from "../session/SessionProvider"

type Props = StaticScreenProps<{
  relayId: string
  instanceId: string
  name: string
}>

const LEVEL_CLASS: Record<string, string> = {
  error: "text-danger",
  warn: "text-warning",
  warning: "text-warning",
}

const ConsoleRow = memo(function ConsoleRow(props: { readonly line: ConsoleLine }) {
  const { line } = props
  return (
    <Text
      selectable
      className={cn(
        "px-3 font-mono text-xs leading-[18px] text-foreground",
        LEVEL_CLASS[line.level]
      )}
    >
      {line.timestamp ? (
        <Text className="text-foreground-muted">{formatClock(line.timestamp)} </Text>
      ) : null}
      {line.segments?.length
        ? line.segments.map((segment, index) => (
            <Text
              key={index}
              style={segment.color ? { color: segment.color } : undefined}
              className={segment.bold ? "font-mono-medium" : undefined}
            >
              {segment.text}
            </Text>
          ))
        : line.text}
    </Text>
  )
})

export function ConsoleScreen({ route }: Props): ReactElement {
  const { relayId, instanceId } = route.params
  const navigation = useNavigation()
  const session = useSession()
  const palette = usePalette()
  const barInset = useBarInset()
  const consoleState = useConsole({ relayId, instanceId })
  const send = useSendCommand({ relayId, instanceId })
  const [command, setCommand] = useState("")
  const list = useRef<FlatList<ConsoleLine>>(null)
  const pinnedToBottom = useRef(true)
  const viewport = useRef({ list: 0, content: 0 })
  const readOnly = session.credential.mode === "read_only"
  const [keyboardOpen, setKeyboardOpen] = useState(false)

  // Output shorter than the list stays at the top, under the header's inset.
  const scrollToEnd = () => {
    if (viewport.current.content > viewport.current.list)
      list.current?.scrollToEnd({ animated: false })
  }

  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => {
      setKeyboardOpen(true)
      if (pinnedToBottom.current) scrollToEnd()
    })
    const hidden = Keyboard.addListener("keyboardDidHide", () =>
      setKeyboardOpen(false)
    )
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View className="flex-row items-center gap-1.5 px-1">
          <View
            className={cn(
              "size-2",
              consoleState.status === "live" ? "bg-success" : "bg-warning"
            )}
          />
          <MonoText className="text-xs text-foreground-muted">
            {consoleState.status}
          </MonoText>
        </View>
      ),
    })
  }, [navigation, consoleState.status])

  // The status belongs to the console; another page of the server drops it.
  useEffect(() => () => navigation.setOptions({ headerRight: undefined }), [navigation])

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    pinnedToBottom.current =
      contentOffset.y + layoutMeasurement.height >= contentSize.height - 48
  }

  const submit = () => {
    const value = command.trim()
    if (!value || send.isPending) return
    void Haptics.selectionAsync()
    send.mutate(value, { onSuccess: () => setCommand("") })
    pinnedToBottom.current = true
    scrollToEnd()
  }

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-screen"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <FlatList
        ref={list}
        className="flex-1"
        contentContainerClassName="pt-3"
        contentContainerStyle={{ paddingBottom: readOnly ? barInset : 12 }}
        contentInsetAdjustmentBehavior="automatic"
        data={consoleState.lines}
        keyExtractor={(line) => line.id}
        renderItem={({ item }) => <ConsoleRow line={item} />}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={(_width, height) => {
          viewport.current.content = height
          if (pinnedToBottom.current) scrollToEnd()
        }}
        onLayout={(event) => {
          viewport.current.list = event.nativeEvent.layout.height
          if (pinnedToBottom.current) scrollToEnd()
        }}
        initialNumToRender={40}
        maxToRenderPerBatch={40}
        windowSize={9}
        ListEmptyComponent={
          <AppText className="px-4 py-8 text-center text-sm text-foreground-muted">
            {consoleState.status === "connecting" ? "Connecting…" : "No output yet."}
          </AppText>
        }
      />
      {consoleState.error && consoleState.status !== "live" ? (
        <View className="border-t border-border bg-card px-4 py-2">
          <AppText className="text-xs text-warning">{consoleState.error}</AppText>
        </View>
      ) : null}
      {send.isError ? (
        <View className="border-t border-border bg-card px-4 py-2">
          <AppText className="text-xs text-danger">{errorMessage(send.error)}</AppText>
        </View>
      ) : null}
      {readOnly ? null : (
        <View
          className="flex-row items-center gap-2 border-t border-border bg-card px-3 pt-2"
          // The bar hides while the keyboard is up; otherwise sit above it.
          style={{ paddingBottom: keyboardOpen ? 8 : barInset - 12 }}
        >
          <MonoText className="text-primary-text">›</MonoText>
          <TextInput
            value={command}
            onChangeText={setCommand}
            placeholder="Send a command"
            placeholderTextColor={palette.muted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
            submitBehavior="submit"
            onSubmitEditing={submit}
            maxLength={512}
            className="min-h-11 flex-1 font-mono text-sm text-foreground"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send command"
            disabled={!command.trim() || send.isPending}
            onPress={submit}
            className={cn(
              "size-10 items-center justify-center bg-primary active:opacity-70",
              (!command.trim() || send.isPending) && "opacity-40"
            )}
          >
            <Icon name="arrow.up" size={16} color="primaryForeground" />
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  )
}
