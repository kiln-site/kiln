import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import { activityInstantSchema } from "@/lib/activity"
import { getActivityForUser } from "@/server/activity-data.server"
import { requireEligibleResourceUser } from "@/server/auth"

const activityRangeSchema = z
  .strictObject({
    from: activityInstantSchema.optional(),
    to: activityInstantSchema.optional(),
  })
  .refine(
    ({ from, to }) =>
      from === undefined ||
      to === undefined ||
      Date.parse(from) <= Date.parse(to),
    "Activity start must be before its end"
  )

export const getActivity = createServerFn({ method: "GET" })
  .validator(activityRangeSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    return getActivityForUser(user, data)
  })

export type ActivityData = Awaited<ReturnType<typeof getActivity>>
export type ActivityEntry = ActivityData["entries"][number]
