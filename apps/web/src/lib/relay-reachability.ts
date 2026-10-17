import type { QueryClient } from "@tanstack/react-query"

type ReachabilityStatus = "connected" | "unreachable"

// Pushed Relay states and stream gaps, ordered against reachability reads.
// A read cannot tell whether Hearth sampled a Relay before or after a push
// that arrived while it was in flight, so the push wins. After a gap, pushes
// may have been missed, so a read that spans one reads again.
interface ReachabilityJournal {
  sequence: number
  gap: number
  pushes: Map<string, { sequence: number; status: ReachabilityStatus }>
}

const journals = new WeakMap<QueryClient, ReachabilityJournal>()
const maximumReads = 3

function journalFor(client: QueryClient): ReachabilityJournal {
  let journal = journals.get(client)
  if (!journal) {
    journal = { sequence: 0, gap: 0, pushes: new Map() }
    journals.set(client, journal)
  }
  return journal
}

export function recordReachabilityPush(
  client: QueryClient,
  relayId: string,
  status: ReachabilityStatus
): void {
  const journal = journalFor(client)
  journal.sequence += 1
  journal.pushes.set(relayId, { sequence: journal.sequence, status })
}

/** The stream was down or reset, so pushes may have been missed. */
export function recordReachabilityGap(client: QueryClient): void {
  const journal = journalFor(client)
  journal.sequence += 1
  journal.gap = journal.sequence
}

/** Reads reachability, keeping pushes that arrived while the read ran. */
export async function readRelayReachability<
  TRelay extends { id: string; status: ReachabilityStatus },
>(
  client: QueryClient,
  signal: AbortSignal,
  read: () => Promise<Array<TRelay>>
): Promise<Array<TRelay>> {
  const journal = journalFor(client)
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = journal.sequence
    const relays = await read()
    // A cancelled read's result is discarded, so do not read again for it.
    if (journal.gap > startedAt && attempt < maximumReads && !signal.aborted)
      continue
    return relays.map((relay) => {
      const push = journal.pushes.get(relay.id)
      return push && push.sequence > startedAt && push.status !== relay.status
        ? { ...relay, status: push.status }
        : relay
    })
  }
}
