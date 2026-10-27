import { Effect } from "effect"
import { expect, it, vi } from "vite-plus/test"

import { samplePassthrough } from "@/lib/relay-metrics"

it("reads what Hearth carried afresh each time it samples", async () => {
  const read = vi.fn(() => [
    {
      bytesFromRelay: 0,
      bytesToRelay: 0,
      open: 0,
      refused: 0,
      relayId: "relay-sampled",
    },
  ])
  const sample = samplePassthrough(read)
  await Effect.runPromise(sample)
  await Effect.runPromise(sample)
  expect(read).toHaveBeenCalledTimes(2)
})
