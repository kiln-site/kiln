import * as React from "react"
import { useDbClient } from "@tanstack/react-db"
import { useQueryClient } from "@tanstack/react-query"

import { getRelayInstancesCollection } from "@/lib/collections/relay-instances"
import { startRealtimeSync } from "@/lib/realtime-sync"

export const RealtimeSync = React.memo(function RealtimeSync() {
  const dbClient = useDbClient()
  const queryClient = useQueryClient()

  // The cleanup closes EventSource and clears every retry/watchdog timer;
  // async work also observes `closed` before applying results.
  React.useEffect(
    () => startRealtimeSync(queryClient, getRelayInstancesCollection(dbClient)),
    [dbClient, queryClient]
  )

  return null
})
