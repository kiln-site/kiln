import { useMutation } from "@tanstack/react-query"
import { Duration, Effect, Fiber, Result, Schedule } from "effect"
import { fetch as streamingFetch } from "expo/fetch"
import { useEffect, useState } from "react"
import { z } from "zod"

import { useSession } from "../session/SessionProvider"
import { apiRequest, errorMessage, HearthError, type HearthSession } from "./hearth"

// Mirrors relayConsoleLineSchema in @workspace/contracts. That module's index
// pulls in every contract, so the app keeps the fields it renders.
const consoleLineSchema = z.object({
  id: z.string(),
  timestamp: z.string().nullable(),
  level: z.string(),
  text: z.string(),
  segments: z
    .array(
      z.object({
        text: z.string(),
        color: z.string().optional(),
        bold: z.boolean().optional(),
      })
    )
    .optional(),
})
export type ConsoleLine = z.infer<typeof consoleLineSchema>

const historySchema = z.object({
  lines: z.array(consoleLineSchema),
  truncated: z.boolean(),
})

const streamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("reset"), lines: z.array(consoleLineSchema) }),
  z.object({ type: z.literal("history"), lines: z.array(consoleLineSchema) }),
  z.object({ type: z.literal("line"), line: consoleLineSchema }),
])

const MAX_LINES = 1_000
const HISTORY_LINES = 300

type Target = { readonly relayId: string; readonly instanceId: string }

export interface ConsoleState {
  readonly lines: ReadonlyArray<ConsoleLine>
  readonly status: "connecting" | "live" | "reconnecting"
  readonly error: string | null
}

const query = (target: Target, extra: Record<string, string>) =>
  new URLSearchParams({ ...target, ...extra }).toString()

const followConsole = Effect.fn("Console.follow")(function* (
  session: HearthSession,
  target: Target,
  emit: (event: z.infer<typeof streamEventSchema>) => void
) {
  const history = yield* apiRequest(
    session,
    `logs?${query(target, { limit: String(HISTORY_LINES) })}`,
    historySchema
  )
  emit({ type: "reset", lines: history.lines })

  const response = yield* Effect.tryPromise({
    try: (signal) =>
      streamingFetch(
        `${session.url}/api/cli/v1/logs?${query(target, { follow: "true" })}`,
        {
          signal,
          headers: {
            Accept: "application/x-ndjson",
            Authorization: `Bearer ${session.token}`,
          },
        }
      ),
    catch: (cause) =>
      HearthError.make({
        code: "network_error",
        message: "The console stream disconnected.",
        status: 0,
        retryable: true,
        cause,
      }),
  })
  const body = response.body
  if (!response.ok || !body)
    return yield* HearthError.make({
      code: "stream_failed",
      message: `The console stream answered ${response.status}.`,
      status: response.status,
      retryable: response.status >= 500,
    })

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const chunk = yield* Effect.tryPromise({
      try: () => reader.read(),
      catch: (cause) =>
        HearthError.make({
          code: "network_error",
          message: "The console stream disconnected.",
          status: 0,
          retryable: true,
          cause,
        }),
    })
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      const raw = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
      if (!raw) continue
      const json = Result.try(() => JSON.parse(raw) as unknown)
      if (Result.isFailure(json)) continue
      const parsed = streamEventSchema.safeParse(json.success)
      if (parsed.success) emit(parsed.data)
    }
  }
  return yield* HearthError.make({
    code: "stream_ended",
    message: "The console stream ended.",
    status: 0,
    retryable: true,
  })
})

/**
 * Streams a game server's console: recent history, then live lines. Lines
 * that arrive together are applied in one render.
 */
export function useConsole(target: Target): ConsoleState {
  const session = useSession()
  const [state, setState] = useState<ConsoleState>({
    lines: [],
    status: "connecting",
    error: null,
  })

  useEffect(() => {
    let pending: Array<z.infer<typeof streamEventSchema>> = []
    let frame: number | null = null
    const flush = () => {
      frame = null
      const events = pending
      pending = []
      setState((current) => {
        let lines = current.lines
        const seen = new Set(lines.map((line) => line.id))
        for (const event of events) {
          if (event.type === "reset") {
            lines = event.lines
            seen.clear()
            for (const line of lines) seen.add(line.id)
          } else if (event.type === "history") {
            const fresh = event.lines.filter((line) => !seen.has(line.id))
            lines = [...lines, ...fresh]
            for (const line of fresh) seen.add(line.id)
          } else if (event.type === "line" && !seen.has(event.line.id)) {
            lines = [...lines, event.line]
            seen.add(event.line.id)
          }
        }
        return {
          lines: lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines,
          status: "live",
          error: null,
        }
      })
    }
    const emit = (event: z.infer<typeof streamEventSchema>) => {
      pending.push(event)
      frame ??= requestAnimationFrame(flush)
    }

    const fiber = Effect.runFork(
      followConsole(session, target, emit).pipe(
        Effect.tapError((error) =>
          Effect.sync(() =>
            setState((current) => ({
              ...current,
              status: "reconnecting",
              error: errorMessage(error),
            }))
          )
        ),
        Effect.retry({
          while: (error) => error.retryable,
          // Back off from 1s, capped at 10s, for as long as the screen is open.
          schedule: Schedule.min([
            Schedule.exponential(Duration.seconds(1)),
            Schedule.spaced(Duration.seconds(10)),
          ]),
        }),
        Effect.catch((error) =>
          Effect.sync(() =>
            setState((current) => ({
              ...current,
              status: "reconnecting",
              error: errorMessage(error),
            }))
          )
        )
      )
    )
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [session, target.relayId, target.instanceId])

  return state
}

const commandResultSchema = z.unknown()

export function useSendCommand(target: Target) {
  const session = useSession()
  return useMutation({
    mutationFn: (command: string) =>
      Effect.runPromise(
        apiRequest(session, "console", commandResultSchema, {
          method: "POST",
          body: JSON.stringify({ ...target, command }),
        })
      ),
  })
}
