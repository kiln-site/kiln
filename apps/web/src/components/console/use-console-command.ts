import * as React from "react"
import { Effect, Result } from "effect"

import {
  completeDirectRelayCommand,
  sendDirectRelayCommand,
} from "@/lib/relay-console-command"

interface CommandCompletions {
  cursor: number
  input: string
  selectedIndex: number
  status: "empty" | "loading" | "ready" | "unavailable"
  suggestions: Array<{
    label: string
    value: string
  }>
}

export function useConsoleCommand(
  instanceId: string,
  relayId: string,
  active: boolean,
  running: boolean,
  available: boolean
) {
  const [error, setError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [sending, setSending] = React.useState(false)
  const sendButtonRef = React.useRef<HTMLButtonElement>(null)
  const setValue = usePersistedCommand(
    instanceId,
    inputRef,
    sendButtonRef,
    running && available,
    sending
  )
  const { navigateHistory, recordCommand } = useCommandHistory(instanceId)
  const [completions, setCompletions] =
    React.useState<CommandCompletions | null>(null)
  const completionListRef = React.useRef<HTMLDivElement>(null)
  const completionSessionActive = React.useRef(false)
  const completionRequest = React.useRef(0)
  const completionPending = React.useRef({ cursor: -1, input: "" })
  const selectedCompletionIndex =
    completions?.status === "ready" ? completions.selectedIndex : null
  React.useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active, instanceId])

  React.useEffect(() => {
    if (selectedCompletionIndex === null) return
    let scrollFrame = 0
    const selectionFrame = window.requestAnimationFrame(() => {
      scrollFrame = window.requestAnimationFrame(() => {
        const selectedOption =
          completionListRef.current?.querySelector<HTMLElement>(
            `#console-completion-${selectedCompletionIndex}`
          )
        selectedOption?.scrollIntoView({ block: "nearest", inline: "nearest" })
      })
    })
    return () => {
      window.cancelAnimationFrame(selectionFrame)
      window.cancelAnimationFrame(scrollFrame)
    }
  }, [selectedCompletionIndex])

  function stopCompletions() {
    completionSessionActive.current = false
    completionRequest.current += 1
    completionPending.current = { cursor: -1, input: "" }
    setCompletions(null)
  }

  function applyCompletion(suggestion: string) {
    if (!completions || completions.status !== "ready") return
    const prefix = completions.input.slice(0, completions.cursor)
    const suffix = completions.input.slice(completions.cursor)
    const completedPrefix = mergeCommandCompletion(prefix, suggestion)
    setCompletions(null)
    setValue(`${completedPrefix}${suffix}`)
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(
        completedPrefix.length,
        completedPrefix.length
      )
    })
  }

  async function requestCompletion(
    input: string,
    cursor: number,
    activateSession = false
  ) {
    if (
      completionPending.current.input === input &&
      completionPending.current.cursor === cursor
    ) {
      return
    }
    const requestId = completionRequest.current + 1
    completionRequest.current = requestId
    completionPending.current = { cursor, input }
    setCompletions({
      cursor,
      input,
      selectedIndex: 0,
      status: "loading",
      suggestions: [],
    })
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          completeDirectRelayCommand(relayId, instanceId, input, cursor),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (completionRequest.current !== requestId) return
            if (!result.supported) {
              completionSessionActive.current = false
              setCompletions(null)
              return
            }
            if (activateSession) completionSessionActive.current = true

            const currentInput = inputRef.current
            if (!currentInput || currentInput.value !== input) {
              if (activateSession && currentInput) {
                void requestCompletion(
                  currentInput.value,
                  currentInput.selectionStart ?? currentInput.value.length
                )
              }
              return
            }
            const suggestionValues = [...result.suggestions]
            if (
              result.completedPrefix &&
              !suggestionValues.includes(result.completedPrefix)
            ) {
              suggestionValues.unshift(result.completedPrefix)
            }
            const prefix = input.slice(0, cursor)
            const suggestions = suggestionValues.map((suggestion) => ({
              label: commandCompletionLabel(prefix, suggestion),
              value: suggestion,
            }))
            setCompletions({
              cursor,
              input,
              selectedIndex: 0,
              status: suggestions.length > 0 ? "ready" : "empty",
              suggestions,
            })
          })
        ),
        Effect.catch(() =>
          Effect.sync(() => {
            if (completionRequest.current === requestId) {
              if (activateSession) completionSessionActive.current = false
              setCompletions({
                cursor,
                input,
                selectedIndex: 0,
                status: "unavailable",
                suggestions: [],
              })
            }
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (
              completionPending.current.input === input &&
              completionPending.current.cursor === cursor
            ) {
              completionPending.current = { cursor: -1, input: "" }
            }
          })
        )
      )
    )
  }

  function navigate(event: React.KeyboardEvent<HTMLInputElement>) {
    if (
      (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
      event.nativeEvent.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return
    }
    const nextCommand = navigateHistory(
      event.key === "ArrowUp" ? "previous" : "next",
      event.currentTarget.value
    )
    if (nextCommand === undefined) return
    event.preventDefault()
    setCompletions(null)
    setValue(nextCommand)
    window.requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.setSelectionRange(input.value.length, input.value.length)
      if (completionSessionActive.current) {
        void requestCompletion(nextCommand, nextCommand.length)
      }
    })
  }

  function keyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return
    if (
      event.key === "Escape" &&
      (completionSessionActive.current || completions)
    ) {
      event.preventDefault()
      stopCompletions()
      return
    }
    if (completions?.status === "ready") {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const direction = event.key === "ArrowDown" ? 1 : -1
        setCompletions((current) =>
          current
            ? {
                ...current,
                selectedIndex: Math.min(
                  Math.max(current.selectedIndex + direction, 0),
                  current.suggestions.length - 1
                ),
              }
            : current
        )
        return
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault()
        const suggestion = completions.suggestions[completions.selectedIndex]
        applyCompletion(suggestion.value)
        return
      }
    }
    if (
      event.key === "Tab" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      running &&
      available
    ) {
      event.preventDefault()
      void requestCompletion(
        event.currentTarget.value,
        event.currentTarget.selectionStart ?? event.currentTarget.value.length,
        true
      )
      return
    }
    navigate(event)
  }

  function change(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget.value
    const cursor = event.currentTarget.selectionStart ?? input.length
    setError(null)
    setValue(input)
    if (completionSessionActive.current) {
      void requestCompletion(input, cursor)
    } else {
      setCompletions(null)
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const command = inputRef.current?.value.trim() ?? ""
    if (!command || !running || !available || sending) return
    stopCompletions()
    recordCommand(command)
    setValue("")
    window.requestAnimationFrame(() => inputRef.current?.focus())
    setSending(true)
    await Effect.runPromise(
      Effect.tryPromise({
        try: () => sendDirectRelayCommand(relayId, instanceId, command),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap(() => Effect.sync(() => setError(null))),
        Effect.catch((cause) =>
          Effect.sync(() => {
            setError(cause instanceof Error ? cause.message : "Command failed")
            setValue(command)
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            setSending(false)
            window.requestAnimationFrame(() => inputRef.current?.focus())
          })
        )
      )
    )
  }

  function selectCompletion(index: number) {
    setCompletions((current) =>
      current ? { ...current, selectedIndex: index } : current
    )
  }

  return {
    applyCompletion,
    available,
    change,
    completionListRef,
    completions,
    error,
    inputRef,
    keyDown,
    running,
    sendButtonRef,
    selectCompletion,
    sending,
    stopCompletions,
    submit,
  }
}

function usePersistedCommand(
  instanceId: string,
  inputRef: React.RefObject<HTMLInputElement | null>,
  sendButtonRef: React.RefObject<HTMLButtonElement | null>,
  running: boolean,
  sending: boolean
) {
  const storageKey = `hearth:console-draft:${instanceId}`

  const syncSubmitAvailability = React.useCallback(
    (value: string) => {
      if (sendButtonRef.current) {
        sendButtonRef.current.disabled = !running || sending || !value.trim()
      }
    },
    [running, sendButtonRef, sending]
  )

  React.useEffect(() => {
    const storedValue = window.sessionStorage.getItem(storageKey) ?? ""
    if (inputRef.current) inputRef.current.value = storedValue
  }, [inputRef, storageKey])

  React.useEffect(() => {
    syncSubmitAvailability(inputRef.current?.value ?? "")
  }, [inputRef, syncSubmitAvailability])

  const setValue = React.useCallback(
    (next: string) => {
      if (inputRef.current) inputRef.current.value = next
      syncSubmitAvailability(next)
      if (next) window.sessionStorage.setItem(storageKey, next)
      else window.sessionStorage.removeItem(storageKey)
    },
    [inputRef, storageKey, syncSubmitAvailability]
  )

  return setValue
}

const commandHistoryLimit = 100

function useCommandHistory(instanceId: string) {
  const storageKey = `kiln:console-history:${instanceId}`
  const history = React.useRef<Array<string>>([])
  const cursor = React.useRef<number | null>(null)
  const pendingDraft = React.useRef("")

  React.useEffect(() => {
    history.current = readCommandHistory(storageKey)
    cursor.current = null
    pendingDraft.current = ""
  }, [storageKey])

  const recordCommand = React.useCallback(
    (command: string) => {
      const current = history.current
      const next =
        current.at(-1) === command
          ? current
          : [...current, command].slice(-commandHistoryLimit)

      history.current = next
      cursor.current = null
      pendingDraft.current = ""
      window.sessionStorage.setItem(storageKey, JSON.stringify(next))
    },
    [storageKey]
  )

  const navigateHistory = React.useCallback(
    (
      direction: "previous" | "next",
      currentValue: string
    ): string | undefined => {
      const commands = history.current
      if (commands.length === 0) return undefined

      if (direction === "previous") {
        if (cursor.current === null) {
          pendingDraft.current = currentValue
          cursor.current = commands.length - 1
        } else {
          cursor.current = Math.max(0, cursor.current - 1)
        }
        return commands[cursor.current]
      }

      if (cursor.current === null) return undefined
      if (cursor.current < commands.length - 1) {
        cursor.current += 1
        return commands[cursor.current]
      }

      cursor.current = null
      return pendingDraft.current
    },
    []
  )

  return { navigateHistory, recordCommand }
}

function mergeCommandCompletion(prefix: string, suggestion: string): string {
  const { contextualStart, tokenStart } = commandCompletionContext(
    prefix,
    suggestion
  )
  if (contextualStart !== undefined) {
    return `${prefix.slice(0, contextualStart)}${suggestion}`
  }

  return `${prefix.slice(0, tokenStart)}${suggestion}`
}

function commandCompletionLabel(prefix: string, suggestion: string): string {
  const { contextualStart, tokenStart } = commandCompletionContext(
    prefix,
    suggestion
  )
  if (contextualStart === undefined) return suggestion

  const completedContext = prefix.slice(contextualStart, tokenStart)
  const label = suggestion.slice(completedContext.length)
  return label || suggestion
}

function commandCompletionContext(prefix: string, suggestion: string) {
  const tokenStarts = [0]
  for (let index = 1; index < prefix.length; index += 1) {
    if (
      /\s/u.test(prefix[index - 1] ?? "") &&
      !/\s/u.test(prefix[index] ?? "")
    ) {
      tokenStarts.push(index)
    }
  }

  const contextualStart = tokenStarts.find((start) => {
    const typedContext = prefix.slice(start)
    return typedContext.length > 0 && suggestion.startsWith(typedContext)
  })
  const tokenStart = /\s$/u.test(prefix)
    ? prefix.length
    : (tokenStarts.at(-1) ?? 0)
  return { contextualStart, tokenStart }
}

function readCommandHistory(storageKey: string): Array<string> {
  return Result.getOrElse(
    Result.try(() => {
      const stored: unknown = JSON.parse(
        window.sessionStorage.getItem(storageKey) ?? "[]"
      )
      if (!Array.isArray(stored)) return []
      return stored
        .filter(
          (command): command is string =>
            typeof command === "string" && command.length > 0
        )
        .slice(-commandHistoryLimit)
    }),
    () => []
  )
}
