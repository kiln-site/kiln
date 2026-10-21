import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import {
  ConsoleRelayMenu,
  ConsoleServiceMenu,
} from "@/components/console/console-filters"
import type { ConsoleUiStore } from "@/components/console/console-stores"
import { tailscaleStacksQueryOptions } from "@/lib/query-options"
import type { TailscaleStackOverview } from "@/server/tailscale"

const emptyTailscaleStacks: Array<TailscaleStackOverview> = []

// Kept apart from the other console filters, which read only the console's
// own stores, because it reads the Tailscale stack from Hearth.
export function TailscaleConsoleFilterMenus({
  instanceId,
  uiStore,
}: {
  instanceId: string
  uiStore: ConsoleUiStore
}) {
  const { data } = useQuery({
    ...tailscaleStacksQueryOptions(),
    notifyOnChangeProps: ["data"],
  })
  const stacks = data?.stacks ?? emptyTailscaleStacks
  const relays = React.useMemo(() => {
    const stack = stacks.find((candidate) => candidate.id === instanceId)
    return (
      stack?.deployments.map(({ relayId, relayName }) => ({
        id: relayId,
        label: relayName,
      })) ?? []
    )
  }, [instanceId, stacks])

  return (
    <>
      <ConsoleRelayMenu relays={relays} uiStore={uiStore} />
      <ConsoleServiceMenu uiStore={uiStore} />
    </>
  )
}
