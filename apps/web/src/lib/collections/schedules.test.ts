import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vite-plus/test"

import { queryKeys } from "@/lib/query-options"
import {
  type HearthSchedule,
  removeScheduleFromCache,
  upsertScheduleCache,
} from "./schedules"

const schedule = (id: string, name: string) => ({ id, name }) as HearthSchedule

describe("schedule collection cache", () => {
  it("puts the confirmed row first without duplicating it", () => {
    const queryClient = new QueryClient()
    const first = schedule("schedule-a", "First")
    const second = schedule("schedule-b", "Second")
    const updated = schedule("schedule-a", "Updated")
    queryClient.setQueryData(queryKeys.schedules.all, [first, second])

    upsertScheduleCache(queryClient, updated)

    expect(queryClient.getQueryData(queryKeys.schedules.all)).toEqual([
      updated,
      second,
    ])
  })

  it("removes only the confirmed deleted row", () => {
    const queryClient = new QueryClient()
    const first = schedule("schedule-a", "First")
    const second = schedule("schedule-b", "Second")
    queryClient.setQueryData(queryKeys.schedules.all, [first, second])

    removeScheduleFromCache(queryClient, first.id)

    expect(queryClient.getQueryData(queryKeys.schedules.all)).toEqual([second])
  })
})
