import * as React from "react"
import { useSuspenseQuery } from "@tanstack/react-query"
import { Plus } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

// Loaded on first click, so empty pages don't carry the pairing flow.
const AddRelayDialog = React.lazy(async () => ({
  default: (await import("@/components/relay/add-relay-dialog")).AddRelayDialog,
}))

function selectAwaitingFirstRelay(capabilities: {
  isPlatformAdmin: boolean
  isRelayCreator: boolean
  relayConfigured: boolean
}): boolean {
  return (
    !capabilities.relayConfigured &&
    (capabilities.isPlatformAdmin || capabilities.isRelayCreator)
  )
}

/** Whether this person can pair a Relay and has none yet. */
export function useAwaitingFirstRelay(): boolean {
  const { data } = useSuspenseQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectAwaitingFirstRelay,
  })
  return data
}

export function AddFirstRelayButton() {
  const [open, setOpen] = React.useState(false)
  const [mounted, setMounted] = React.useState(false)
  return (
    <>
      <Button
        size="sm"
        type="button"
        onClick={() => {
          setMounted(true)
          setOpen(true)
        }}
      >
        <Plus /> Add Relay
      </Button>
      {mounted ? (
        <React.Suspense fallback={null}>
          <AddRelayDialog open={open} onOpenChange={setOpen} />
        </React.Suspense>
      ) : null}
    </>
  )
}
