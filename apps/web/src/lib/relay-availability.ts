import { RelayUnavailableError } from "@/effect/errors"

/** What anyone asking a paused Relay for a change is told. */
export const relayPausedMessage =
  "This Relay is paused. Resume it to make changes."

export function relayPausedError(): RelayUnavailableError {
  return RelayUnavailableError.make({
    code: "relay_paused",
    message: relayPausedMessage,
    retryable: false,
  })
}
