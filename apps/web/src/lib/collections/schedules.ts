import { collectionOptions } from "@tanstack/react-db"
import type { QueryClient } from "@tanstack/react-query"
import { queryCollectionOptions } from "@tanstack/query-db-collection"

import { queryKeys } from "@/lib/query-options"
import { getSchedules } from "@/server/schedules"

export type HearthSchedule = Awaited<ReturnType<typeof getSchedules>>[number]

export const schedulesCollectionOptions = collectionOptions(
  "hearth-schedules",
  (client) =>
    queryCollectionOptions({
      id: "hearth-schedules",
      getKey: (schedule) => schedule.id,
      queryClient: client.requireDependency<QueryClient>("queryClient"),
      queryFn: () => getSchedules(),
      queryKey: queryKeys.schedules.all,
      refetchInterval: 15_000,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    })
)

export function upsertScheduleCache(
  queryClient: QueryClient,
  schedule: HearthSchedule | undefined
): void {
  if (!schedule) return
  queryClient.setQueryData<Array<HearthSchedule>>(
    queryKeys.schedules.all,
    (current) => [
      schedule,
      ...(current ?? []).filter((item) => item.id !== schedule.id),
    ]
  )
}

export function removeScheduleFromCache(
  queryClient: QueryClient,
  scheduleId: string
): void {
  queryClient.setQueryData<Array<HearthSchedule>>(
    queryKeys.schedules.all,
    (current) => current?.filter((item) => item.id !== scheduleId) ?? []
  )
}
