// A command another page hands to a terminal it opens, typed at the prompt
// but not run. Kept in memory, never in the URL, so a link can't put a
// command in someone's shell; it lapses if no terminal takes it soon.

const FRESH_MS = 30_000

const queued = new Map<string, { at: number; text: string }>()

export function queueTerminalInput(key: string, text: string) {
  queued.set(key, { at: Date.now(), text })
}

/** The queued command for a terminal, once. */
export function takeTerminalInput(key: string): string | null {
  const entry = queued.get(key)
  queued.delete(key)
  return entry && Date.now() - entry.at < FRESH_MS ? entry.text : null
}

/** Where a page queues a command for a Relay's host shell. */
export function relayTerminalInputKey(relayId: string) {
  return `relay:${relayId}`
}
