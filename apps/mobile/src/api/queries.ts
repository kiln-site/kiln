import { useIsFocused } from "@react-navigation/native"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  cliActivityResponseSchema,
  cliPowerResponseSchema,
  cliRelayInfoResponseSchema,
  cliRelaysResponseSchema,
  cliServerInfoResponseSchema,
  cliServersResponseSchema,
  type cliPowerActionSchema,
} from "@workspace/contracts/cli"
import { Effect } from "effect"
import { z } from "zod"

import { useSession } from "../session/SessionProvider"
import { apiRequest, type HearthSession } from "./hearth"

export type PowerAction = z.infer<typeof cliPowerActionSchema>
export type ServerSummary = z.infer<
  typeof cliServersResponseSchema
>["servers"][number]
export type RelaySummary = z.infer<
  typeof cliRelaysResponseSchema
>["relays"][number]
export type ServerInfo = z.infer<typeof cliServerInfoResponseSchema>
export type RelayInfo = z.infer<typeof cliRelayInfoResponseSchema>
export type ActivityEntry = z.infer<
  typeof cliActivityResponseSchema
>["entries"][number]

// The CLI declares this inline (apps/cli/src/main.ts); mirror it here
// rather than widening the shared contracts for a prototype.
export const cliWhoamiResponseSchema = z.object({
  credential: z.object({
    id: z.string(),
    mode: z.enum(["full_access", "read_only"]),
  }),
  user: z.object({ email: z.string(), id: z.string(), name: z.string() }),
})

const run = <T>(effect: Effect.Effect<T, unknown>, signal: AbortSignal) =>
  Effect.runPromise(effect, { signal })

const targetQuery = (target: { relayId: string; instanceId: string }) =>
  new URLSearchParams(target).toString()

/**
 * Live data polls only while its screen is on top and the app is in the
 * foreground (React Query pauses refetch intervals in the background).
 */
function useLiveInterval(ms: number): number | false {
  return useIsFocused() ? ms : false
}

const keys = {
  servers: (s: HearthSession) => [s.url, "servers"] as const,
  relays: (s: HearthSession) => [s.url, "relays"] as const,
  server: (s: HearthSession, instanceId: string) =>
    [s.url, "server", instanceId] as const,
  relay: (s: HearthSession, relayId: string) =>
    [s.url, "relay", relayId] as const,
  activity: (s: HearthSession) => [s.url, "activity"] as const,
  whoami: (s: HearthSession) => [s.url, "whoami"] as const,
}

export function useServers() {
  const session = useSession()
  return useQuery({
    queryKey: keys.servers(session),
    queryFn: ({ signal }) =>
      run(apiRequest(session, "servers", cliServersResponseSchema), signal),
    select: (data) => data.servers,
    refetchInterval: useLiveInterval(5_000),
  })
}

export function useRelays() {
  const session = useSession()
  return useQuery({
    queryKey: keys.relays(session),
    queryFn: ({ signal }) =>
      run(apiRequest(session, "relays", cliRelaysResponseSchema), signal),
    select: (data) => data.relays,
    refetchInterval: useLiveInterval(10_000),
  })
}

export function useServerInfo(target: { relayId: string; instanceId: string }) {
  const session = useSession()
  return useQuery({
    queryKey: keys.server(session, target.instanceId),
    queryFn: ({ signal }) =>
      run(
        apiRequest(
          session,
          `server/info?${targetQuery(target)}`,
          cliServerInfoResponseSchema
        ),
        signal
      ),
    refetchInterval: useLiveInterval(3_000),
  })
}

export function useRelayInfo(relayId: string, options?: { enabled?: boolean }) {
  const session = useSession()
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: keys.relay(session, relayId),
    queryFn: ({ signal }) =>
      run(
        apiRequest(
          session,
          `relay/info?${new URLSearchParams({ relayId })}`,
          cliRelayInfoResponseSchema
        ),
        signal
      ),
    refetchInterval: useLiveInterval(5_000),
  })
}

export function useActivity() {
  const session = useSession()
  return useQuery({
    queryKey: keys.activity(session),
    queryFn: ({ signal }) =>
      run(
        apiRequest(session, "activity?limit=100", cliActivityResponseSchema),
        signal
      ),
    select: (data) => data.entries,
    refetchInterval: useLiveInterval(15_000),
  })
}

export function useWhoami() {
  const session = useSession()
  return useQuery({
    queryKey: keys.whoami(session),
    queryFn: ({ signal }) =>
      run(apiRequest(session, "whoami", cliWhoamiResponseSchema), signal),
    staleTime: 60_000,
  })
}

export function usePowerAction(target: {
  relayId: string
  instanceId: string
}) {
  const session = useSession()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (action: PowerAction) =>
      Effect.runPromise(
        apiRequest(session, "power", cliPowerResponseSchema, {
          method: "POST",
          body: JSON.stringify({ ...target, action }),
        })
      ),
    onSuccess: (result) => {
      // Show the new desired state at once; the next poll fills in the rest.
      queryClient.setQueryData<ServerInfo>(
        keys.server(session, target.instanceId),
        (current) =>
          current && {
            ...current,
            server: {
              ...current.server,
              desiredState: result.instance.desiredState,
              observedState: result.instance.observedState,
            },
          }
      )
      void queryClient.invalidateQueries({ queryKey: keys.servers(session) })
    },
  })
}
