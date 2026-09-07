export async function requireRelayIssuerRetirement(input: {
  minimumGeneration: number
  revise: (minimumGeneration: number) => Promise<boolean>
  supportsRevisionDelivery: boolean
}): Promise<void> {
  if (!input.supportsRevisionDelivery) return
  if (!Number.isSafeInteger(input.minimumGeneration)) {
    throw new Error("Relay issuer generation is outside the safe integer range")
  }
  if (await input.revise(input.minimumGeneration)) return
  throw new Error(
    "Relay did not acknowledge browser issuer retirement; it was paused and was not deleted"
  )
}
